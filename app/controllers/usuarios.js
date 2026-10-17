// Gerenciamento de Usuários: lista paginada, busca, remoção de warns e desbanimento (unban).
import { db } from '../../config/database.js';
import { getGroupTitle } from '../models/group.js';
import { ensureBotPerm } from '../helpers/admin.js';

export const ITENS_POR_PAGINA = 6;

// Retorna lista paginada e contagem de usuários com dados no grupo (warns, punições ou mensagens)
export function listarUsuariosGrupo(gid, pagina = 0, busca = '') {
  const gStr = String(gid);
  const offset = Math.max(0, pagina) * ITENS_POR_PAGINA;
  const termo = String(busca || '').trim().replace(/^@/, '');

  let whereFiltro = '';
  const paramsFiltro = [gStr, gStr, gStr];

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

  // Contagem total
  const countSql = `
    SELECT COUNT(*) as total
    FROM (
      SELECT DISTINCT user_id FROM warns WHERE group_id = ?
      UNION
      SELECT DISTINCT user_id FROM events WHERE group_id = ? AND (kind LIKE '%ban%' OR kind LIKE '%mute%')
      UNION
      SELECT DISTINCT user_id FROM messages_log WHERE group_id = ? AND user_id > 0
    ) u
    LEFT JOIN users usr ON usr.id = u.user_id
    ${whereFiltro}
  `;
  const total = db.prepare(countSql).get(...paramsFiltro)?.total || 0;

  // Consulta paginada
  const queryParams = [
    gStr, gStr, gStr, // base u
    gStr,             // w
    gStr,             // b
    gStr,             // m
  ];
  if (termo) {
    if (/^\d+$/.test(termo)) {
      queryParams.push(Number(termo));
    } else {
      const lk = `%${termo}%`;
      queryParams.push(lk, lk, lk);
    }
  }
  queryParams.push(ITENS_POR_PAGINA, offset);

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
      COALESCE(m.cnt_msgs, 0) as total_msgs,
      MAX(COALESCE(w.last_warn, ''), COALESCE(b.last_ban, ''), COALESCE(m.last_msg, '')) as ultima_atividade
    FROM (
      SELECT DISTINCT user_id FROM warns WHERE group_id = ?
      UNION
      SELECT DISTINCT user_id FROM events WHERE group_id = ? AND (kind LIKE '%ban%' OR kind LIKE '%mute%')
      UNION
      SELECT DISTINCT user_id FROM messages_log WHERE group_id = ? AND user_id > 0
    ) u
    LEFT JOIN users usr ON usr.id = u.user_id
    LEFT JOIN (
      SELECT user_id, COUNT(*) as cnt_warns, MAX(created_at) as last_warn
      FROM warns WHERE group_id = ? GROUP BY user_id
    ) w ON w.user_id = u.user_id
    LEFT JOIN (
      SELECT user_id, COUNT(*) as cnt_bans, MAX(created_at) as last_ban
      FROM events WHERE group_id = ? AND (kind LIKE '%ban%' OR kind LIKE '%mute%') GROUP BY user_id
    ) b ON b.user_id = u.user_id
    LEFT JOIN (
      SELECT user_id, COUNT(*) as cnt_msgs, MAX(criado_em) as last_msg
      FROM messages_log WHERE group_id = ? AND user_id > 0 GROUP BY user_id
    ) m ON m.user_id = u.user_id
    ${whereFiltro}
    ORDER BY total_warns DESC, total_bans DESC, ultima_atividade DESC
    LIMIT ? OFFSET ?
  `;

  const usuarios = db.prepare(sql).all(...queryParams);
  return { usuarios, total, pagina, termo };
}

// Detalhes completos de um usuário específico no grupo
export function obterDetalhesUsuario(gid, uid) {
  const gStr = String(gid);
  const uNum = Number(uid);

  const perfil = db.prepare('SELECT * FROM users WHERE id = ?').get(uNum) || null;
  const warns = db.prepare('SELECT * FROM warns WHERE group_id = ? AND user_id = ? ORDER BY id DESC').all(gStr, uNum);
  const punicoes = db.prepare("SELECT * FROM events WHERE group_id = ? AND user_id = ? AND (kind LIKE '%ban%' OR kind LIKE '%mute%') ORDER BY id DESC LIMIT 10").all(gStr, uNum);
  const ultimasMsgs = db.prepare('SELECT texto, criado_em FROM messages_log WHERE group_id = ? AND user_id = ? ORDER BY criado_em DESC LIMIT 3').all(gStr, uNum);

  return { perfil, warns, punicoes, ultimasMsgs };
}

// Formata nome legível do usuário
export function formatarNomeUsuario(u, uid) {
  if (u?.username) return `@${u.username}`;
  const partes = [u?.first_name, u?.last_name].filter(Boolean);
  if (partes.length) return partes.join(' ');
  return `ID: ${uid}`;
}

// Painel principal da lista de usuários
export function painelListaUsuarios(gid, pagina = 0, busca = '') {
  const gStr = String(gid);
  const titulo = getGroupTitle(gStr);
  const { usuarios, total, termo } = listarUsuariosGrupo(gStr, pagina, busca);
  const totalPaginas = Math.ceil(total / ITENS_POR_PAGINA) || 1;
  const pagAtual = Math.min(Math.max(0, pagina), totalPaginas - 1);

  let head = `👥 <b>${titulo}</b>\n\n`;
  head += `👤 <b>Gerenciamento de Usuários</b>\n`;
  if (termo) {
    head += `🔍 Filtro atual: <code>${termo}</code> (${total} encontrado(s))\n`;
  } else {
    head += `Mostrando usuários ativos, advertidos ou punidos (${total} total)\n`;
  }
  head += `Página <b>${pagAtual + 1}</b> de <b>${totalPaginas}</b>\n\n`;

  if (!usuarios.length) {
    head += `<i>Nenhum usuário encontrado para esta seleção.</i>`;
  } else {
    head += `Selecione um usuário para gerenciar warns e bans:`;
  }

  const rows = [];
  for (const u of usuarios) {
    const nome = formatarNomeUsuario(u, u.user_id);
    const badges = [];
    if (u.total_warns > 0) badges.push(`⚠️ ${u.total_warns}`);
    if (u.total_bans > 0) badges.push(`🚫 ${u.total_bans}`);
    const badgeTxt = badges.length ? ` [${badges.join(' ')}]` : '';
    rows.push([{
      text: `${nome}${badgeTxt}`,
      callback_data: `usr_view:${gStr}:${u.user_id}:${pagAtual}`,
    }]);
  }

  // Linha de navegação (ciclar)
  const navRow = [];
  if (pagAtual > 0) {
    navRow.push({ text: '⬅️ Anterior', callback_data: `usr_list:${gStr}:${pagAtual - 1}` });
  }
  if (pagAtual < totalPaginas - 1) {
    navRow.push({ text: 'Próxima ➡️', callback_data: `usr_list:${gStr}:${pagAtual + 1}` });
  }
  if (navRow.length) rows.push(navRow);

  // Ações de pesquisa e retorno
  const actionRow = [
    { text: termo ? '❌ Limpar busca' : '🔍 Pesquisar', callback_data: termo ? `usr_list:${gStr}:0` : `usr_search:${gStr}` },
    { text: '⬅️ Voltar ao Menu', callback_data: `open:${gStr}` },
  ];
  rows.push(actionRow);

  return { text: head, reply_markup: { inline_keyboard: rows } };
}

// Painel detalhado de um usuário selecionado
export async function painelDetalhesUsuario(bot, gid, uid, paginaOrigem = 0) {
  const gStr = String(gid);
  const uNum = Number(uid);
  const titulo = getGroupTitle(gStr);
  const { perfil, warns, punicoes } = obterDetalhesUsuario(gStr, uNum);

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

  let txt = `👥 <b>${titulo}</b>\n\n`;
  txt += `👤 <b>Usuário:</b> ${nome}\n`;
  txt += `🆔 <b>ID:</b> <code>${uNum}</code>\n`;
  txt += `📌 <b>Status no grupo:</b> ${statusLabel}\n\n`;

  txt += `⚠️ <b>Total de Warns:</b> ${warns.length}\n`;
  if (warns.length > 0) {
    const recentes = warns.slice(0, 3).map((w, idx) => `  ${idx + 1}. <code>${w.reason || 'sem motivo'}</code> (${w.created_at.slice(0, 16)})`).join('\n');
    txt += `${recentes}\n`;
  }

  txt += `\n🚫 <b>Histórico de Bans/Mutes:</b> ${punicoes.length}\n`;
  if (punicoes.length > 0) {
    const recentesP = punicoes.slice(0, 2).map((p, idx) => `  ${idx + 1}. ${p.kind} em ${p.created_at.slice(0, 16)}`).join('\n');
    txt += `${recentesP}\n`;
  }

  const rows = [];
  const actionRow = [];

  // Botão remover warns se houver
  if (warns.length > 0) {
    actionRow.push({ text: '⚠️ Zerar Warns', callback_data: `usr_del_warns:${gStr}:${uNum}:${paginaOrigem}` });
  }

  // Botão desbanir / remover restrição
  actionRow.push({ text: '🔓 Desbanir / Desmutar', callback_data: `usr_unban:${gStr}:${uNum}:${paginaOrigem}` });
  rows.push(actionRow);

  rows.push([
    { text: '⬅️ Voltar para Lista', callback_data: `usr_list:${gStr}:${paginaOrigem}` },
  ]);

  return { text: txt, reply_markup: { inline_keyboard: rows } };
}

// Remove todos os warns de um usuário no grupo
export function zerarWarnsUsuario(gid, uid) {
  const gStr = String(gid);
  const uNum = Number(uid);
  const res = db.prepare('DELETE FROM warns WHERE group_id = ? AND user_id = ?').run(gStr, uNum);
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
