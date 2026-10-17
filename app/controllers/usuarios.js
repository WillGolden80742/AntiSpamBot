// Gerenciamento de Usuários por MOTOR: 'alfabeto' | 'sem' (antispam).
// Cada lista só enxerga warns/bans DO SEU motor (prefixo reason + kind do evento).
// Detalhe mostra só o histórico do motor + zera/desbane SÓ aquele motor.
export const MOTORES = {
  alfabeto: {
    chave: 'alfabeto', emoji: '🔤', nome: 'Alfabetos',
    warnLike: 'alfabeto:%',
    banKinds: ["kind LIKE 'alfabeto_ban'", "kind LIKE 'alfabeto_mute'"],
  },
  sem: {
    chave: 'sem', emoji: '🛡', nome: 'Antispam',
    warnLike: 'sem:%',
    banKinds: ["kind LIKE 'sem_ban'", "kind LIKE 'sem_mute'"],
  },
};
export function normMotor(m) {
  return m === 'sem' ? 'sem' : 'alfabeto';
}
function cfgMotor(motor) { return MOTORES[normMotor(motor)]; }
import { db } from '../../config/database.js';
import { getGroupTitle } from '../models/group.js';
import { ensureBotPerm } from '../helpers/admin.js';

export const ITENS_POR_PAGINA = 6;

// Filtro ativo da lista por conversa (preserva busca ao paginar/trocar ordem).
// chave `${chatId}:${gid}` → { busca, ordem }
const filtrosLista = new Map();
export function setFiltroLista(chatId, gid, filtro = {}) {
  const k = `${chatId}:${gid}`;
  const cur = filtrosLista.get(k) || { busca: '', ordem: 'recentes' };
  filtrosLista.set(k, {
    busca: filtro.busca ?? cur.busca ?? '',
    ordem: filtro.ordem === 'antigos' ? 'antigos' : filtro.ordem === 'recentes' ? 'recentes' : (cur.ordem || 'recentes'),
  });
}
export function getFiltroLista(chatId, gid) {
  return filtrosLista.get(`${chatId}:${gid}`) || { busca: '', ordem: 'recentes' };
}

// Nome com caractere fora do repertório ocidental/latino = última prioridade na lista.
const NAO_OCIDENTAL_RE = /[^\u0000-\u024F\u0300-\u036F\u1D00-\u1DBF\u1E00-\u1EFF\u2C60-\u2C7F\uA720-\uA7FF\uAB30-\uAB6F]/;
const TEM_LETRA_NUM = /[\p{L}\p{N}]/u;
export function ehNomeNaoOcidental(nome) {
  const t = String(nome || '');
  if (!NAO_OCIDENTAL_RE.test(t)) return false;
  const resto = [...t].filter((ch) => NAO_OCIDENTAL_RE.test(ch)).join('');
  return TEM_LETRA_NUM.test(resto);
}

// Retorna lista paginada e contagem de usuários COM PENDÊNCIA NO MOTOR
// (warns ou bans/mutes do motor). Sem pendência = fora da lista.
// ordem: 'recentes' (última atividade DESC) | 'antigos' (ASC). Não ocidentais sempre por último.
export function listarUsuariosGrupo(gid, pagina = 0, busca = '', ordem = 'recentes', motor = 'alfabeto') {
  const gStr = String(gid);
  const termo = String(busca || '').trim().replace(/^@/, '');
  const ord = ordem === 'antigos' ? 'antigos' : 'recentes';
  const cfg = cfgMotor(motor);
  const banCond = `(${cfg.banKinds.join(' OR ')})`;

  let whereFiltro = '';
  const paramsFiltro = [gStr, cfg.warnLike, gStr];

  if (termo) {
    if (/^\d+$/.test(termo)) {
      whereFiltro = 'WHERE u.user_id = ?';
      paramsFiltro.push(Number(termo));
    } else {
      whereFiltro = 'WHERE (usr.username LIKE ? OR usr.first_name LIKE ? OR usr.last_name LIKE ?)';
      const lk = `%${termo}%`;
      paramsFiltro.push(lk, lk, lk);
    }
  }

  // Contagem total (só quem tem pendência NO MOTOR)
  const countSql = `
    SELECT COUNT(*) as total
    FROM (
      SELECT DISTINCT user_id FROM warns WHERE group_id = ? AND reason LIKE ?
      UNION
      SELECT DISTINCT user_id FROM events WHERE group_id = ? AND ${banCond}
    ) u
    LEFT JOIN users usr ON usr.id = u.user_id
    ${whereFiltro}
  `;
  const total = db.prepare(countSql).get(...paramsFiltro)?.total || 0;

  // Busca TODOS os candidatos com o filtro e ordena em JS:
  // ocidentais primeiro (recentes ou antigos), não ocidentais sempre por último.
  const queryParams = [
    gStr, cfg.warnLike, // base u (warns)
    gStr,               // base u (events)
    gStr, cfg.warnLike, // w
    gStr,               // b
  ];
  if (termo) {
    if (/^\d+$/.test(termo)) {
      queryParams.push(Number(termo));
    } else {
      const lk = `%${termo}%`;
      queryParams.push(lk, lk, lk);
    }
  }

  const sql = `
    SELECT
      u.user_id,
      usr.username,
      usr.first_name,
      usr.last_name,
      COALESCE(w.cnt_warns, 0) as total_warns,
      COALESCE(w.last_warn, '') as last_warn,
      COALESCE(b.cnt_bans, 0) as total_bans,
      COALESCE(b.last_ban, '') as last_ban,
      MAX(COALESCE(w.last_warn, ''), COALESCE(b.last_ban, '')) as ultima_atividade
    FROM (
      SELECT DISTINCT user_id FROM warns WHERE group_id = ? AND reason LIKE ?
      UNION
      SELECT DISTINCT user_id FROM events WHERE group_id = ? AND ${banCond}
    ) u
    LEFT JOIN users usr ON usr.id = u.user_id
    LEFT JOIN (
      SELECT user_id, COUNT(*) as cnt_warns, MAX(created_at) as last_warn
      FROM warns WHERE group_id = ? AND reason LIKE ? GROUP BY user_id
    ) w ON w.user_id = u.user_id
    LEFT JOIN (
      SELECT user_id, COUNT(*) as cnt_bans, MAX(created_at) as last_ban
      FROM events WHERE group_id = ? AND ${banCond} GROUP BY user_id
    ) b ON b.user_id = u.user_id
    ${whereFiltro}
  `;

  const todos = db.prepare(sql).all(...queryParams);
  // Nome exibido + flag não ocidental (calculados aqui p/ ordenar sem nova query).
  // A separação 🌐 por último vale SÓ p/ o Antispam — na lista de Alfabetos
  // ela não se aplica (os infratores de alfabeto SÃO os não ocidentais).
  const separaNaoOci = cfg.chave !== 'alfabeto';
  for (const u of todos) {
    u._nome = formatarNomeUsuario(u, u.user_id);
    u._naoOci = separaNaoOci ? ehNomeNaoOcidental(u._nome) : false;
  }
  const cmpData = (a, b) => {
    const da = a.ultima_atividade || '';
    const db2 = b.ultima_atividade || '';
    if (!da && !db2) return 0;
    if (!da) return 1;   // sem data sempre por último, nas duas ordens
    if (!db2) return -1;
    return ord === 'antigos' ? (da < db2 ? -1 : da > db2 ? 1 : 0) : (da > db2 ? -1 : da < db2 ? 1 : 0);
  };
  const ocidentais = todos.filter((u) => !u._naoOci).sort(cmpData);
  const naoOci = todos.filter((u) => u._naoOci).sort(cmpData);
  const ordenados = [...ocidentais, ...naoOci];

  const totalPaginas = Math.ceil(ordenados.length / ITENS_POR_PAGINA) || 1;
  const pagAtual = Math.min(Math.max(0, Number(pagina) || 0), totalPaginas - 1);
  const usuarios = ordenados.slice(pagAtual * ITENS_POR_PAGINA, pagAtual * ITENS_POR_PAGINA + ITENS_POR_PAGINA);
  return { usuarios, total: ordenados.length, pagina: pagAtual, termo, ordem: ord, motor: cfg.chave };
}

// Detalhes completos de um usuário específico no grupo — SÓ o motor pedido
export function obterDetalhesUsuario(gid, uid, motor = 'alfabeto') {
  const gStr = String(gid);
  const uNum = Number(uid);
  const cfg = cfgMotor(motor);
  const banCond = `(${cfg.banKinds.join(' OR ')})`;

  const perfil = db.prepare('SELECT * FROM users WHERE id = ?').get(uNum) || null;
  const warns = db.prepare('SELECT * FROM warns WHERE group_id = ? AND user_id = ? AND reason LIKE ? ORDER BY id DESC').all(gStr, uNum, cfg.warnLike);
  const punicoes = db.prepare(`SELECT * FROM events WHERE group_id = ? AND user_id = ? AND ${banCond} ORDER BY id DESC LIMIT 10`).all(gStr, uNum);

  return { perfil, warns, punicoes };
}

// Formata nome legível do usuário — NOME primeiro (username vira detalhe).
// Ex.: "João Silva (@joao)" · "Maria" · "@fulano" · "ID 123 (sem nome salvo)".
export function formatarNomeUsuario(u, uid) {
  const partes = [u?.first_name, u?.last_name].filter(Boolean);
  const nome = partes.length ? partes.join(' ') : '';
  if (nome && u?.username) return `${nome} (@${u.username})`;
  if (nome) return nome;
  if (u?.username) return `@${u.username}`;
  return `ID ${uid} (sem nome salvo)`;
}

// Completa o cache de nomes da página atual via API (6 chamadas, rápido).
// Sem isso, usuários antigos aparecem como "ID ... (sem nome salvo)".
// Salva no banco p/ as próximas aberturas já virem com nome.
export async function enriquecerPerfis(bot, gid, usuarios) {
  if (!bot || !usuarios?.length) return;
  const gStr = String(gid);
  await Promise.allSettled(usuarios.map(async (u) => {
    if (u.username || u.first_name) return;
    try {
      const m = await bot.getChatMember(gStr, Number(u.user_id));
      const f = m?.user;
      if (!f) return;
      u.username = f.username || null;
      u.first_name = f.first_name || null;
      u.last_name = f.last_name || null;
      try {
        db.prepare(`
          INSERT INTO users (id, username, first_name, last_name, atualizado_em)
          VALUES (?, ?, ?, ?, datetime('now'))
          ON CONFLICT(id) DO UPDATE SET
            username = excluded.username,
            first_name = excluded.first_name,
            last_name = excluded.last_name,
            atualizado_em = excluded.atualizado_em
        `).run(Number(u.user_id), u.username, u.first_name, u.last_name);
      } catch {}
      u._nome = formatarNomeUsuario(u, u.user_id);
      u._naoOci = ehNomeNaoOcidental(u._nome);
    } catch {}
  }));
  // Reordena SÓ a página: ocidentais primeiro, 🌐 por último (separação visível
  // mesmo antes do cache completar para todos os 109).
  usuarios.sort((a, b) => (Number(!!a._naoOci) - Number(!!b._naoOci)));
}

// Painel principal da lista de usuários DE UM MOTOR.
// bot opcional (6º arg): se passado, completa os nomes da página via API e salva no cache.
// voltarPara: callback de retorno (alfabetos → mod_alfa, antispam → ai).
export async function painelListaUsuarios(gid, pagina = 0, busca = '', ordem = 'recentes', motor = 'alfabeto', bot = null) {
  // Compat com chamada antiga de 5 args (gid, pag, busca, ordem, bot):
  if (bot === null && motor !== null && typeof motor === 'object' && typeof motor.getChatMember === 'function') {
    bot = motor; motor = 'alfabeto';
  }
  const cfg = cfgMotor(motor);
  const gStr = String(gid);
  const titulo = getGroupTitle(gStr);
  const { usuarios, total, termo, ordem: ordReal } = listarUsuariosGrupo(gStr, pagina, busca, ordem, cfg.chave);
  if (bot) await enriquecerPerfis(bot, gStr, usuarios);
  const totalPaginas = Math.ceil(total / ITENS_POR_PAGINA) || 1;
  const pagAtual = Math.min(Math.max(0, Number(pagina) || 0), totalPaginas - 1);
  const temNaoOci = usuarios.some((u) => u._naoOci);
  const voltarCb = cfg.chave === 'sem' ? `ai:${gStr}` : `mod_alfa:${gStr}`;

  let head = `👥 <b>${titulo}</b>\n\n`;
  head += `${cfg.emoji} <b>Warns & Bans — ${cfg.nome}</b>\n`;
  head += `Ordem: <b>${ordReal === 'antigos' ? 'mais antigos' : 'mais recentes'}</b>${cfg.chave === 'sem' ? ' · 🌐 não ocidentais por último' : ''}\n`;
  if (termo) {
    head += `🔍 Filtro atual: <code>${termo}</code> (${total} encontrado(s))\n`;
  } else if (total) {
    head += `Com pendência neste motor (${total} total)\n`;
  } else {
    head += `Ninguém com pendência neste motor 🎉\n`;
  }
  head += `Página <b>${pagAtual + 1}</b> de <b>${totalPaginas}</b>\n\n`;

  if (!usuarios.length) {
    head += `<i>Nenhum usuário com warn/ban de ${cfg.nome}.</i>`;
  } else {
    head += `Selecione um usuário para gerenciar:`;
    if (temNaoOci && usuarios.some((u) => u._naoOci)) head += `\n<i>🌐 = nome não ocidental (última prioridade)</i>`;
  }

  const prefixoCb = `usr_${cfg.chave}`;
  const rows = [];
  for (const u of usuarios) {
    const nome = u._nome || formatarNomeUsuario(u, u.user_id);
    const badges = [];
    if (u.total_warns > 0) badges.push(`⚠️ ${u.total_warns}`);
    if (u.total_bans > 0) badges.push(`🚫 ${u.total_bans}`);
    const badgeTxt = badges.length ? ` [${badges.join(' ')}]` : '';
    const prefixo = u._naoOci ? '🌐 ' : '';
    let rotulo = `${prefixo}${nome}${badgeTxt}`;
    if (rotulo.length > 60) rotulo = `${rotulo.slice(0, 57)}…`;
    rows.push([{
      text: rotulo,
      callback_data: `${prefixoCb}_view:${gStr}:${u.user_id}:${pagAtual}`,
    }]);
  }

  // Linha de navegação (preserva busca + ordem ao paginar)
  const navRow = [];
  if (pagAtual > 0) {
    navRow.push({ text: '⬅️ Anterior', callback_data: `${prefixoCb}_list:${gStr}:${pagAtual - 1}` });
  }
  if (pagAtual < totalPaginas - 1) {
    navRow.push({ text: 'Próxima ➡️', callback_data: `${prefixoCb}_list:${gStr}:${pagAtual + 1}` });
  }
  if (navRow.length) rows.push(navRow);

  // Toggle de ordem + pesquisa + retorno ao motor
  rows.push([
    { text: ordReal === 'antigos' ? '🕒 Ver recentes' : '📜 Ver antigos', callback_data: `${prefixoCb}_ord:${gStr}:${ordReal === 'antigos' ? 'recentes' : 'antigos'}` },
  ]);
  const actionRow = [
    { text: termo ? '❌ Limpar busca' : '🔍 Pesquisar', callback_data: termo ? `${prefixoCb}_clear:${gStr}` : `${prefixoCb}_search:${gStr}` },
    { text: '⬅️ Voltar', callback_data: voltarCb },
  ];
  rows.push(actionRow);

  return { text: head, reply_markup: { inline_keyboard: rows } };
}

// Painel detalhado de um usuário selecionado — SÓ o motor pedido.
// Zerar/desbanir afetam SÓ esse motor.
export async function painelDetalhesUsuario(bot, gid, uid, paginaOrigem = 0, motor = 'alfabeto') {
  const cfg = cfgMotor(motor);
  const gStr = String(gid);
  const uNum = Number(uid);
  const titulo = getGroupTitle(gStr);
  const { perfil, warns, punicoes } = obterDetalhesUsuario(gStr, uNum, cfg.chave);

  // Checa status do usuário diretamente na API do chat
  let statusTelegram = 'desconhecido';
  try {
    const member = await bot.getChatMember(gStr, uNum);
    statusTelegram = member.status; // creator, administrator, member, restricted, left, kicked
  } catch (err) {
    statusTelegram = 'não localizado / fora do grupo';
  }

  const statusLabel = {
    creator: '👑 Dono / Criador',
    administrator: '👮‍♂️ Administrador',
    member: '✅ Membro comum',
    restricted: '🔇 Silenciado / Restrito',
    left: '🚪 Saiu do grupo',
    kicked: '🚫 Banido',
  }[statusTelegram] || statusTelegram;

  const nome = formatarNomeUsuario(perfil, uNum);
  const prefixoCb = `usr_${cfg.chave}`;

  let txt = `👥 <b>${titulo}</b>\n\n`;
  txt += `${cfg.emoji} <b>${cfg.nome}</b>\n`;
  txt += `👤 <b>Usuário:</b> ${nome}\n`;
  txt += `🆔 <b>ID:</b> <code>${uNum}</code>\n`;
  txt += `📌 <b>Status no grupo:</b> ${statusLabel}\n\n`;

  txt += `⚠️ <b>Warns (${cfg.nome}):</b> ${warns.length}\n`;
  if (warns.length > 0) {
    const recentes = warns.slice(0, 3).map((w, idx) => `  ${idx + 1}. <code>${w.reason || 'sem motivo'}</code> (${w.created_at.slice(0, 16)})`).join('\n');
    txt += `${recentes}\n`;
  }

  txt += `\n🚫 <b>Bans/Mutes (${cfg.nome}):</b> ${punicoes.length}\n`;
  if (punicoes.length > 0) {
    const recentesP = punicoes.slice(0, 2).map((p, idx) => `  ${idx + 1}. ${p.kind} em ${p.created_at.slice(0, 16)}`).join('\n');
    txt += `${recentesP}\n`;
  }

  const rows = [];
  const actionRow = [];

  // Botão remover warns do MOTOR se houver
  if (warns.length > 0) {
    actionRow.push({ text: `⚠️ Zerar Warns (${cfg.nome})`, callback_data: `${prefixoCb}_del_warns:${gStr}:${uNum}:${paginaOrigem}` });
  }

  // Botão desbanir / remover restrição
  actionRow.push({ text: '🔓 Desbanir / Desmutar', callback_data: `${prefixoCb}_unban:${gStr}:${uNum}:${paginaOrigem}` });
  rows.push(actionRow);

  rows.push([
    { text: '⬅️ Voltar para Lista', callback_data: `${prefixoCb}_list:${gStr}:${paginaOrigem}` },
  ]);

  return { text: txt, reply_markup: { inline_keyboard: rows } };
}

// Remove os warns DE UM MOTOR do usuário no grupo
export function zerarWarnsUsuario(gid, uid, motor = 'alfabeto') {
  const gStr = String(gid);
  const uNum = Number(uid);
  const cfg = cfgMotor(motor);
  const res = db.prepare('DELETE FROM warns WHERE group_id = ? AND user_id = ? AND reason LIKE ?').run(gStr, uNum, cfg.warnLike);
  return res.changes || 0;
}

// Desbane o usuário na API do Telegram e remove restrições
export async function desbanirUsuario(bot, gid, uid) {
  const gStr = String(gid);
  const uNum = Number(uid);

  const permCheck = await ensureBotPerm(bot, gStr, 'can_restrict_members');
  if (!permCheck.ok) {
    return { ok: false, error: 'Bot sem permissão de desbanir/restringir membros no grupo.' };
  }

  try {
    // unbanChatMember remove o ban e permite reentrada
    await bot.unbanChatMember(gStr, uNum, { only_if_banned: true }).catch(() => {});
    // Se estiver restrito, restaura permissões padrão de envio
    await bot.restrictChatMember(gStr, uNum, {
      permissions: {
        can_send_messages: true,
        can_send_media_messages: true,
        can_send_other_messages: true,
        can_add_web_page_previews: true,
      },
    }).catch(() => {});
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
