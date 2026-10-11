// Hub enxuto: 2 motores (alfabetos + antispam semântico, 0 IA).
// Antispam é o pai de regras (texto) e whitelist (perdão).
// Menu (open:) -> hub (mod:) -> [mod_alfa: | ai: -> [wl: | cens_ver/editar | sem_treinar]].
// Legado: `mod:gid` antigo cai no hub; callbacks ia_* antigas são ignoradas.
import { logEvent } from '../models/group.js';
import { settingsKeyboard } from '../helpers/keyboards.js';
import { senderIsAdmin } from '../helpers/admin.js';
import { setPendente } from '../helpers/pending.js';
import { getWhitelist, painelWhitelist, removerWlItem } from '../helpers/whitelist.js';
import { getRegrasTexto } from '../helpers/regras.js';
import { getProgressivoCfg, ALFA_NOME, EXCETO_KEYS, normExcecoes, normSelecao, selecaoAtiva } from './alfabetos.js';
import { getSemCfg, saveSemCfg, painelSemantico, painelTolerancia, painelTolNumeros, varreduraGrupo, retreinar } from './semantico.js';
import { db } from '../../config/database.js';

const META = {
  alfabetos: ['Alfabetos', 'O que o bot faz quando alguém escreve em árabe, chinês, cirílico e outros alfabetos.'],
};

// Punção por alfabeto — o clique abre um SUBMENU de MULTISSELEÇÃO:
// cada flag (Deletar | Silenciar | Banir | Progressivo) marca/desmarca sozinha —
// ex.: marque Deletar + Silenciar em vez do antigo "Silenciar + Deletar".
// Desativar limpa tudo de uma vez. Desmarcar tudo também desativa.
// Regras: Progressivo é exclusivo com Silenciar/Banir imediatos (o fluxo manda
// na final); Silenciar e Banir são exclusivos entre si (ban já remove);
// Deletar combina com qualquer um (só ele marcado = "só apago").
const ALFABETOS = [
  { key: 'arabe', label: 'ÁRABE', emoji: '☪️', listEmoji: '☪️', name: 'Árabe' },
  { key: 'cirilico', label: 'CIRÍLICO', emoji: '🇷🇺', listEmoji: '🇷🇺', name: 'Cirílico' },
  { key: 'chines', label: 'CHINÊS', emoji: '🇨🇳', listEmoji: '🇨🇳', name: 'Chinês' },
  { key: 'latim', label: 'LATIM', emoji: '🔤', listEmoji: '🔤', name: 'Latim' },
  { key: 'hindi', label: 'HINDI', emoji: '🇮🇳', listEmoji: '🇮🇳', name: 'Hindi' },
  { key: 'bengali', label: 'BENGALI', emoji: '🇧🇩', listEmoji: '🇧🇩', name: 'Bengali' },
  { key: 'nao_ocidental', label: 'NÃO OCIDENTAL', emoji: '🌐', listEmoji: '🌐', name: 'Não ocidental' },
];
const PUNISH_CYCLE = ['desativado', 'deletar', 'silenciar+deletar', 'ban+deletar', 'progressivo'];
// Toggles do submenu (multisseleção). O antigo PUNISH_OPCOES virou legado:
// botões ab_set: de mensagens já abertas ainda funcionam via mapa abaixo.
const MULTI_FLAGS = [
  { key: 'deletar', label: 'Deletar', emoji: '🗑' },
  { key: 'silenciar', label: 'Silenciar', emoji: '🔇' },
  { key: 'banir', label: 'Banir', emoji: '🚫' },
  { key: 'progressivo', label: 'Progressivo', emoji: '▶️' },
];
// Mapa legado ab_set: -> seleção (mensagens antigas com o submenu de escolha única).
const LEGADO_PARA_SEL = {
  desativado: {},
  deletar: { deletar: true },
  silenciar: { silenciar: true },
  mute: { silenciar: true },
  'silenciar+deletar': { deletar: true, silenciar: true },
  'ban+deletar': { deletar: true, banir: true },
  ban: { banir: true },
  progressivo: { deletar: true, progressivo: true },
};
const PUNISH_OPCOES = [
  { key: 'desativado', label: 'Desativado', desc: 'ignora esse alfabeto' },
  { key: 'deletar', label: 'Apenas deletar', desc: 'só apaga, nunca bane/muta, nunca avisa warn' },
  { key: 'silenciar+deletar', label: 'Silenciar + Deletar', desc: 'remoção + restrição de envio' },
  { key: 'ban+deletar', label: 'Ban + Deletar', desc: 'remoção + banimento' },
  { key: 'progressivo', label: 'Progressivo', desc: 'avisa Xx e aplica a punição final' },
];
const PUNISH_LABEL = {
  desativado: 'Desativado',
  deletar: 'Apenas deletar',
  silenciar: 'Apenas deletar',
  'silenciar+deletar': 'Silenciar + Deletar',
  'ban+deletar': 'Ban + Deletar',
  progressivo: 'Progressivo',
};
// Ação final do progressivo: Ban → Mute → Apenas deletar → Ban
const ACAO_FINAL_CYCLE = ['ban', 'mute', 'deletar'];
const ACAO_FINAL_LABEL = { ban: 'Ban', mute: 'Mute (silenciar)', deletar: 'Apenas deletar' };
const MAX_CYCLE = [2, 3, 4, 5];
function normPunish(v) {
  if (v === 'progressivo' || v === 'progressive' || v === 'seguir_progressivo') return 'progressivo';
  if (v === 'deletar' || v === 'delete') return 'deletar';
  // legado: "silenciar" sozinho foi trocado por "deletar" (migra automaticamente)
  if (v === 'silenciar' || v === 'mute') return 'deletar';
  if (v === 'silenciar+deletar' || v === 'mute+delete' || v === 'delete+mute') return 'silenciar+deletar';
  if (v === 'ban+deletar' || v === 'ban' || v === 'kick' || v === 'banir') return 'ban+deletar';
  return 'desativado';
}
function getMod(gid, mod) {
  const row = db.prepare('SELECT data FROM settings WHERE group_id = ? AND module = ?').get(String(gid), mod);
  return row ? JSON.parse(row.data) : {};
}
function saveMod(gid, mod, data) {
  // upsert: funciona mesmo se a linha do módulo ainda não existir (grupo antigo)
  db.prepare(`INSERT INTO settings (group_id, module, data, updated_at) VALUES (?,?,?,?)
    ON CONFLICT(group_id, module) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`)
    .run(String(gid), mod, JSON.stringify(data), new Date().toISOString());
  logEvent('settings_change', gid, null, { module: mod });
}
function groupOf(gid) {
  return db.prepare('SELECT * FROM groups WHERE id = ?').get(String(gid));
}
function getAlfabetos(gid) {
  const c = getMod(gid, 'alfabetos');
  const out = {};
  for (const a of ALFABETOS) out[a.key] = normSelecao(c[a.key]);
  return out;
}
function onOff(v) { return v ? 'ligado' : 'desligado'; }
function onOffCurto(v) { return v ? 'ON' : 'OFF'; }
// Textos curtos e amigáveis do estado de cada alfabeto.
const STATUS_PILL = {
  desativado: '⏸ Desligado',
  deletar: '🗑 Só apago',
  silenciar: '🗑 Só apago',
  'silenciar+deletar': '🔇 Apago + silencio',
  'ban+deletar': '🚫 Apago + bano',
  progressivo: '▶️ Progressivo',
};
const STATUS_CURTO = {
  desativado: 'Off',
  deletar: 'Só apaga',
  silenciar: 'Só apaga',
  'silenciar+deletar': 'Muta',
  'ban+deletar': 'Bane',
  progressivo: 'Progr.',
};
// ---- etiquetas da multisseleção (a config agora é um conjunto, não 1 string) ----
function selLista(sel) {
  const s = normSelecao(sel);
  const out = [];
  if (s.deletar) out.push('Deletar');
  if (s.silenciar) out.push('Silenciar');
  if (s.banir) out.push('Banir');
  if (s.progressivo) out.push('Progressivo');
  return out;
}
function selPill(sel) {
  const s = normSelecao(sel);
  if (!selecaoAtiva(s)) return '⏸ Desligado';
  if (s.progressivo) return '▶️ Progressivo';
  const partes = [];
  if (s.deletar) partes.push('🗑 Apago');
  if (s.silenciar) partes.push('🔇 silencio');
  if (s.banir) partes.push('🚫 bano');
  return partes.join(' + ') || '⏸ Desligado';
}
function selCurto(sel) {
  const s = normSelecao(sel);
  if (!selecaoAtiva(s)) return 'Off';
  if (s.progressivo) return 'Progr.';
  const partes = [];
  if (s.deletar && !s.silenciar && !s.banir) return 'Só apaga';
  if (s.banir) partes.push('Bane');
  else if (s.silenciar) partes.push('Muta');
  if (s.deletar) partes.push('+apaga');
  return partes.join(' ') || 'On';
}
function selNome(sel, prog) {
  const s = normSelecao(sel);
  if (!selecaoAtiva(s)) return 'Desativado';
  const base = selLista(s).join(' + ');
  if (s.progressivo) {
    const finalLbl = ACAO_FINAL_LABEL[prog?.acao_final] ?? 'Ban';
    return prog?.progressivo_enabled ? `${base} (${prog.max_warns}x + ${finalLbl})` : `${base} (${finalLbl} na hora)`;
  }
  return base;
}
// Resumo em 1-2 frases do que o grupo vai sentir na prática.
// Flags fixas (deletar/silenciar/banir) NUNCA entram no progressivo —
// mesmo com o passo a passo ligado. Só quem tem "Progressivo" usa avisos + punição final.
function resumoComportamento(cfg, prog, exc) {
  const ativos = ALFABETOS.filter((a) => {
    if (a.key !== 'nao_ocidental' && exc.includes(a.key) && !selecaoAtiva(cfg[a.key])) return false;
    return selecaoAtiva(cfg[a.key]);
  });
  if (!ativos.length) return '⏸ Está tudo desligado — nenhuma ação por alfabeto.';
  const fixos = ativos.filter((a) => !normSelecao(cfg[a.key]).progressivo);
  const progs = ativos.filter((a) => normSelecao(cfg[a.key]).progressivo);
  const avisa = prog.avisar_no_grupo ? 'avisando no grupo' : 'sem avisar no grupo';
  const partes = [];
  if (fixos.length) {
    const soApagam = fixos.every((a) => {
      const s = normSelecao(cfg[a.key]);
      return s.deletar && !s.silenciar && !s.banir;
    });
    if (soApagam && !progs.length) return `🗑 Apenas remoção de mensagem, ${avisa}. Sem banimento e sem restrição de envio.`;
    const nomes = fixos.map((a) => `${a.name} (${selCurto(cfg[a.key])})`).join(', ');
    partes.push(`⚡ Na hora, sem avisos: ${nomes}`);
  }
  if (progs.length) {
    const nomesP = progs.map((a) => a.name).join(', ');
    if (!prog.progressivo_enabled) {
      const finalLbl = prog.acao_final === 'ban' ? 'ban' : prog.acao_final === 'mute' ? 'mute' : 'só apaga';
      partes.push(`▶️ ${nomesP} em modo progressivo, mas o passo a passo está OFF — aplica ${finalLbl} na hora`);
    } else if (prog.acao_final === 'deletar') {
      partes.push(`🗑 ${nomesP}: remove e avisa sempre que necessário (${avisa}), sem banimento e sem restrição de envio`);
    } else {
      const final = prog.acao_final === 'ban' ? 'banimento' : 'restrição de envio';
      partes.push(`⚠️ ${nomesP}: remove e avisa até ${prog.max_warns}x; na ocorrência ${prog.max_warns}, aplica-se ${final} (${avisa})`);
    }
  }
  return partes.join('.\n') + '.';
}
// Submenu de UM alfabeto: MULTISSELEÇÃO — Deletar | Silenciar | Banir | Progressivo.
// Cada toque marca/desmarca só aquela flag. Desativar limpa tudo.
// Desmarcar tudo também desativa.
function alfabetoDetalhePanel(gid, key) {
  const a = ALFABETOS.find((x) => x.key === key);
  if (!a) return alfabetosPanel(gid);
  const raw = getMod(gid, 'alfabetos');
  const cur = normSelecao(raw[key]);
  const prog = getProgressivoCfg(raw);
  const finalLbl = ACAO_FINAL_LABEL[prog.acao_final] ?? 'Ban';
  const hoje = selecaoAtiva(cur) ? selNome(cur, prog) : 'Desativado';
  let obs = '';
  if (cur.progressivo) {
    obs = prog.progressivo_enabled
      ? ` (avisa ${prog.max_warns}x, na última: ${finalLbl})`
      : ` (passo a passo OFF — aplica ${finalLbl} na hora)`;
  } else if (cur.deletar && !cur.silenciar && !cur.banir && selecaoAtiva(cur)) {
    obs = ' (apenas remoção — sem banimento, sem contagem de avisos, mesmo com passo a passo ligado)';
  }
  const head =
    `${a.listEmoji} <b>${a.name}</b> — marque o que fazer quando alguém escrever nisso:\n` +
    `Hoje: <b>${hoje}</b>${obs}` +
    `\n\nToque para marcar/desmarcar. <b>Desativar</b> limpa tudo.`;
  const btn = (flagKey, emoji, label, marcado, extra = '') => ({
    text: `${marcado ? '✅' : '⬜'} ${emoji} ${label}${extra}`,
    callback_data: `ab_tgl:${gid}:${key}:${flagKey}`,
  });
  const rows = [
    [btn('deletar', '🗑', 'Deletar', cur.deletar), btn('silenciar', '🔇', 'Silenciar', cur.silenciar)],
    [btn('banir', '🚫', 'Banir', cur.banir),
     btn('progressivo', '▶️', 'Progressivo', cur.progressivo,
       cur.progressivo
         ? (prog.progressivo_enabled ? ` (${prog.max_warns}x + ${finalLbl})` : ` (${finalLbl} na hora)`)
         : '')],
    [{ text: `${selecaoAtiva(cur) ? '⏸ Desativar (limpa tudo)' : '✅ Desativado'}`, callback_data: `ab_tgl:${gid}:${key}:desativado` }],
  ];
  rows.push([{ text: '⬅️ Voltar', callback_data: `mod_alfa:${gid}` }]);
  return { text: head, reply_markup: { inline_keyboard: rows } };
}
function alfabetosPanel(gid) {
  const cfg = getAlfabetos(gid);
  const raw = getMod(gid, 'alfabetos');
  const prog = getProgressivoCfg(raw);
  const exc = normExcecoes(raw.exceto_nao_ocidental);
  const head =
    '🔤 <b>Alfabetos</b>\n' +
    'O que o bot faz quando alguém escreve nesses alfabetos. Toque num alfabeto e marque: deletar, silenciar, banir e/ou passo a passo.\n\n' +
    `📌 <b>O que acontece hoje</b>\n${resumoComportamento(cfg, prog, exc)}`;
  const lines = ALFABETOS.map((a) => {
    const sel = normSelecao(cfg[a.key]);
    const liberado = a.key !== 'nao_ocidental' && exc.includes(a.key) && !selecaoAtiva(sel);
    const sit = liberado ? '✅ Liberado'
      : selecaoAtiva(sel) && exc.includes(a.key) ? `${selPill(sel)} ⚠️ (a liberação não vale p/ ele)`
      : selPill(sel);
    const extra = a.key === 'nao_ocidental' && exc.length
      ? `\n└ Liberados: ${exc.map((k) => ALFA_NOME[k]).join(', ')}` : '';
    return `${a.listEmoji} <b>${a.name}</b> — ${sit}${extra}`;
  });
  const dicas =
    `\n\n💡 <b>Para entender</b>\n` +
    `• Latim = português. Só ligue se quiser apagar português também.\n` +
    `• Não ocidental é a rede de proteção (grego, hebraico, tailandês…). Emoji sozinho nunca pune.\n` +
    `• É possível combinar: Deletar + Silenciar, Deletar + Banir ou apenas uma opção. Opções marcadas aplicam na hora, sem avisos. Só o Progressivo usa avisos.`;
  const temProgressivo = ALFABETOS.some((a) => normSelecao(cfg[a.key]).progressivo);
  const todosSoApagam = ALFABETOS.every((a) => {
    const s = normSelecao(cfg[a.key]);
    return !selecaoAtiva(s) || (s.deletar && !s.silenciar && !s.banir && !s.progressivo) ||
      (a.key !== 'nao_ocidental' && exc.includes(a.key) && !selecaoAtiva(s));
  });
  const notaFinal = todosSoApagam && !temProgressivo && prog.acao_final !== 'deletar'
    ? ' (sem efeito agora — está tudo em "Só apago"/desligado)' : '';
  const progHead =
    `\n\n⚙️ <b>Como punir</b>\n` +
    `└ Passo a passo: ${onOff(prog.progressivo_enabled)}${prog.progressivo_enabled ? ` (avisa ${prog.max_warns}x antes)` : ' (ação imediata)'}\n` +
    `└ Na última vez: ${ACAO_FINAL_LABEL[prog.acao_final] ?? 'Ban'}${notaFinal}\n` +
    `└ Avisa no grupo: ${onOff(prog.avisar_no_grupo)}\n` +
    `└ Registra nos ADMs: ${onOff(prog.log_no_admin_grupo)}\n` +
    `└ Testar com admins: ${onOff(prog.punir_staff)}\n` +
    `└ Grupo dos ADMs: ${prog.admin_grupo_id ? `<code>${prog.admin_grupo_id}</code>` : 'falta definir — use /setlog no grupo dos ADMs'}`;
  const rows = [];
  for (let i = 0; i < ALFABETOS.length; i += 2) {
    rows.push(ALFABETOS.slice(i, i + 2).map((a) => ({ text: `${a.emoji} ${a.name}: ${selCurto(cfg[a.key])}`, callback_data: `ab:${gid}:${a.key}` })));
  }
  // Linha "Exceto" — scripts permitidos pelo catch-all "Não ocidental"
  rows.push([
    { text: `➖ Não ocidental libera: ${exc.length ? exc.map((k) => ALFA_NOME[k]).join(', ') : 'ninguém'}`, callback_data: `ab_exceto:${gid}` },
  ]);
  // Linha progressivo
  rows.push([
    { text: `▶️ Passo a passo: ${onOffCurto(prog.progressivo_enabled)}`, callback_data: `ab_prog:${gid}` },
    { text: `⚠️ Avisos: ${prog.max_warns}`, callback_data: `ab_max:${gid}` },
  ]);
  rows.push([
    { text: `🚫 Ação final: ${ACAO_FINAL_LABEL[prog.acao_final] ?? 'Ban'}`, callback_data: `ab_final:${gid}` },
    { text: `📢 Aviso no grupo: ${onOffCurto(prog.avisar_no_grupo)}`, callback_data: `ab_warnmsg:${gid}` },
  ]);
  rows.push([
    { text: `🛡 Registro ADM: ${onOffCurto(prog.log_no_admin_grupo)}`, callback_data: `ab_log:${gid}` },
    { text: '⬅️ Voltar', callback_data: `open:${gid}` },
  ]);
  rows.push([
    { text: `🧪 Admin entra no teste: ${onOffCurto(prog.punir_staff)}`, callback_data: `ab_staff:${gid}` },
  ]);
  return { text: `${head}\n\n${lines.join('\n')}${dicas}${progHead}`, reply_markup: { inline_keyboard: rows } };
}
function panel(gid) {
  return alfabetosPanel(gid);
}
// Submenu de exceções do catch-all "Não ocidental".
function excetoPanel(gid) {
  const c = getMod(gid, 'alfabetos');
  const exc = normExcecoes(c.exceto_nao_ocidental);
  const head =
    '➖ <b>Quem passa pela rede de proteção</b>\n' +
    'O "Não ocidental" bloqueia grego, hebraico, tailandês e outros. Exceções (liberações) abaixo.\n' +
    'Ex.: marcar Cirílico → russo passa (até com emoji junto); o resto continua bloqueado.\n\n' +
    '💡 Só vale quando esse alfabeto está <b>desligado</b> lá na tela anterior — se ele tiver qualquer marca (deletar, silenciar, banir ou progressivo), vale ela.';
  const rows = EXCETO_KEYS.map((k) => ([{
    text: `${exc.includes(k) ? '✅' : '⬜'} ${ALFA_NOME[k]}`,
    callback_data: `ab_excts:${gid}:${k}`,
  }]));
  rows.push([{ text: '⬅️ Voltar', callback_data: `mod_alfa:${gid}` }]);
  return { text: head, reply_markup: { inline_keyboard: rows } };
}
function menuText(gid) {
  const g = groupOf(gid);
  return `CONFIGURAÇÕES\nGrupo: ${g?.title ?? gid}\n\nSelecione o motor que deseja configurar.`;
}
function hubPanel(gid) {
  return { text: menuText(gid), reply_markup: settingsKeyboard(gid) };
}
async function canEdit(bot, q, gid) {
  if (await senderIsAdmin(bot, String(gid), q.from.id)) return true;
  await bot.answerCallbackQuery(q.id, { text: 'Ação restrita a administradores deste grupo.', show_alert: true });
  return false;
}

export function registerCallbacks(bot) {
  bot.on('callback_query', async (q) => {
    const data = q.data || '';
    try {
      const edit = (text, reply_markup) => bot.editMessageText(text, {
        chat_id: q.message.chat.id, message_id: q.message.message_id, reply_markup, parse_mode: 'HTML',
      });
      if (data.startsWith('open:')) {
        const gid = data.slice(5);
        if (!(await canEdit(bot, q, gid))) return;
        await edit(menuText(gid), settingsKeyboard(gid));
      } else if (data.startsWith('done:')) {
        await edit('Configurações concluídas e salvas.', undefined);
      } else if (data.startsWith('mod:')) {
        // legado: `mod:gid[:alfabetos]` (mensagens antigas) → hub de módulos.
        const [, gid] = data.split(':');
        if (!(await canEdit(bot, q, gid))) return;
        const p = hubPanel(gid);
        await edit(p.text, p.reply_markup);
      } else if (data.startsWith('mod_alfa:')) {
        const gid = data.split(':')[1];
        if (!(await canEdit(bot, q, gid))) return;
        const p = panel(gid);
        await edit(p.text, p.reply_markup);
      } else if (data.startsWith('ab_exceto:')) {
        const gid = data.split(':')[1];
        if (!(await canEdit(bot, q, gid))) return;
        const p = excetoPanel(gid);
        await edit(p.text, p.reply_markup);
      } else if (data.startsWith('ab_excts:')) {
        const [, gid, key] = data.split(':');
        if (!(await canEdit(bot, q, gid))) return;
        if (!EXCETO_KEYS.includes(key)) return;
        const c = getMod(gid, 'alfabetos');
        const set = new Set(normExcecoes(c.exceto_nao_ocidental));
        if (set.has(key)) set.delete(key); else set.add(key);
        c.exceto_nao_ocidental = [...set];
        saveMod(gid, 'alfabetos', c);
        const p = excetoPanel(gid); await edit(p.text, p.reply_markup);
        await bot.answerCallbackQuery(q.id, { text: `${ALFA_NOME[key]}: ${set.has(key) ? 'permitido' : 'bloqueado'}` }).catch(() => {});
        return;
      } else if (data.startsWith('ab_prog:')) {
        const gid = data.split(':')[1];
        if (!(await canEdit(bot, q, gid))) return;
        const c = getMod(gid, 'alfabetos');
        const cur = getProgressivoCfg(c);
        c.progressivo_enabled = !cur.progressivo_enabled;
        saveMod(gid, 'alfabetos', c);
        const p = alfabetosPanel(gid); await edit(p.text, p.reply_markup);
        await bot.answerCallbackQuery(q.id, { text: `Passo a passo ${c.progressivo_enabled ? 'ligado: avisa antes de agir' : 'desligado: ação imediata'}` }).catch(() => {});
        return;
      } else if (data.startsWith('ab_max:')) {
        const gid = data.split(':')[1];
        if (!(await canEdit(bot, q, gid))) return;
        const c = getMod(gid, 'alfabetos');
        const cur = getProgressivoCfg(c).max_warns;
        const next = MAX_CYCLE[(MAX_CYCLE.indexOf(cur) + 1) % MAX_CYCLE.length] ?? 3;
        c.max_warns = next;
        saveMod(gid, 'alfabetos', c);
        const p = alfabetosPanel(gid); await edit(p.text, p.reply_markup);
        await bot.answerCallbackQuery(q.id, { text: `Avisos antes da ação final: ${next}` }).catch(() => {});
        return;
      } else if (data.startsWith('ab_final:')) {
        const gid = data.split(':')[1];
        if (!(await canEdit(bot, q, gid))) return;
        const c = getMod(gid, 'alfabetos');
        const cur = getProgressivoCfg(c).acao_final;
        const next = ACAO_FINAL_CYCLE[(ACAO_FINAL_CYCLE.indexOf(cur) + 1) % ACAO_FINAL_CYCLE.length] ?? 'ban';
        c.acao_final = next;
        saveMod(gid, 'alfabetos', c);
        const p = alfabetosPanel(gid); await edit(p.text, p.reply_markup);
        await bot.answerCallbackQuery(q.id, { text: `Na última vez: ${ACAO_FINAL_LABEL[next]}` }).catch(() => {});
        return;
      } else if (data.startsWith('ab_warnmsg:')) {
        const gid = data.split(':')[1];
        if (!(await canEdit(bot, q, gid))) return;
        const c = getMod(gid, 'alfabetos');
        const cur = getProgressivoCfg(c);
        c.avisar_no_grupo = !cur.avisar_no_grupo;
        saveMod(gid, 'alfabetos', c);
        const p = alfabetosPanel(gid); await edit(p.text, p.reply_markup);
        await bot.answerCallbackQuery(q.id, { text: `Aviso no grupo ${c.avisar_no_grupo ? 'ligado' : 'desligado'}` }).catch(() => {});
        return;
      } else if (data.startsWith('ab_log:')) {
        const gid = data.split(':')[1];
        if (!(await canEdit(bot, q, gid))) return;
        const c = getMod(gid, 'alfabetos');
        const cur = getProgressivoCfg(c);
        c.log_no_admin_grupo = !cur.log_no_admin_grupo;
        saveMod(gid, 'alfabetos', c);
        const p = alfabetosPanel(gid); await edit(p.text, p.reply_markup);
        await bot.answerCallbackQuery(q.id, { text: `Log ADM ${c.log_no_admin_grupo ? 'ligado' : 'desligado'}` }).catch(() => {});
        return;
      } else if (data.startsWith('ab_staff:')) {
        const gid = data.split(':')[1];
        if (!(await canEdit(bot, q, gid))) return;
        const c = getMod(gid, 'alfabetos');
        const cur = getProgressivoCfg(c);
        c.punir_staff = !cur.punir_staff;
        saveMod(gid, 'alfabetos', c);
        const p = alfabetosPanel(gid); await edit(p.text, p.reply_markup);
        await bot.answerCallbackQuery(q.id, { text: c.punir_staff ? 'Modo teste ligado: inclui administradores.' : 'Modo teste desligado: não se aplica a administradores.' }).catch(() => {});
        return;
      } else if (data.startsWith('ab_tgl:')) {
        // submenu MULTISSELEÇÃO: marca/desmarca 1 flag; 'desativado' limpa tudo.
        // Desmarcar tudo também desativa. Exclusividades: progressivo ×
        // (silenciar/banir); silenciar × banir. Deletar combina com tudo.
        const [, gid, key, flag] = data.split(':');
        if (!(await canEdit(bot, q, gid))) return;
        if (!ALFABETOS.some((a) => a.key === key)) return;
        if (!['deletar', 'silenciar', 'banir', 'progressivo', 'desativado'].includes(flag)) return;
        const c = getMod(gid, 'alfabetos');
        let next;
        if (flag === 'desativado') {
          next = 'desativado';
        } else {
          const s = normSelecao(c[key]);
          s[flag] = !s[flag];
          if (flag === 'progressivo' && s.progressivo) {
            s.silenciar = false; s.banir = false; s.deletar = true;
          }
          if (flag === 'silenciar' && s.silenciar) { s.banir = false; s.progressivo = false; }
          if (flag === 'banir' && s.banir) { s.silenciar = false; s.progressivo = false; }
          next = selecaoAtiva(s) ? { ...s } : 'desativado';
        }
        c[key] = next;
        delete c.enabled; delete c.allowed;
        saveMod(gid, 'alfabetos', c);
        const p = alfabetoDetalhePanel(gid, key); await edit(p.text, p.reply_markup);
        const nomeAlfa = ALFA_NOME[key] ?? key;
        const lbl = next === 'desativado' ? 'Desativado' : selNome(next, getProgressivoCfg(c));
        await bot.answerCallbackQuery(q.id, { text: `${nomeAlfa}: ${lbl}` }).catch(() => {});
        return;
      } else if (data.startsWith('ab_set:')) {
        // LEGADO: submenu antigo de escolha única (mensagens já abertas).
        // Converte o valor antigo em seleção e mostra o submenu novo.
        const [, gid, key, val] = data.split(':');
        if (!(await canEdit(bot, q, gid))) return;
        if (!ALFABETOS.some((a) => a.key === key)) return;
        if (!(val in LEGADO_PARA_SEL)) return;
        const c = getMod(gid, 'alfabetos');
        const sel = LEGADO_PARA_SEL[val];
        c[key] = selecaoAtiva(sel) ? { ...sel } : 'desativado';
        delete c.enabled; delete c.allowed;
        saveMod(gid, 'alfabetos', c);
        const p = alfabetoDetalhePanel(gid, key); await edit(p.text, p.reply_markup);
        const nomeAlfa = ALFA_NOME[key] ?? key;
        await bot.answerCallbackQuery(q.id, { text: `${nomeAlfa}: ${PUNISH_LABEL[val] ?? val}` }).catch(() => {});
        return;
      } else if (data.startsWith('ab:')) {
        // abre o SUBMENU do alfabeto (multisseleção).
        const [, gid, key] = data.split(':');
        if (!(await canEdit(bot, q, gid))) return;
        if (!ALFABETOS.some((a) => a.key === key)) return;
        const p = alfabetoDetalhePanel(gid, key); await edit(p.text, p.reply_markup);
        return;
      } else if (data.startsWith('ai:')) {
        const gid = data.split(':')[1];
        if (!(await canEdit(bot, q, gid))) return;
        const p = painelSemantico(gid); await edit(p.text, p.reply_markup);
        return;
      } else if (data.startsWith('ai_tgl:')) {
        const gid = data.split(':')[1];
        if (!(await canEdit(bot, q, gid))) return;
        const cfg = getSemCfg(gid); cfg.enabled = !cfg.enabled;
        saveSemCfg(gid, cfg);
        const p = painelSemantico(gid); await edit(p.text, p.reply_markup);
        await bot.answerCallbackQuery(q.id, { text: `Antispam ${cfg.enabled ? 'ligado' : 'desligado'}` }).catch(() => {});
        return;
      } else if (data.startsWith('ai_max:')) {
        const gid = data.split(':')[1];
        if (!(await canEdit(bot, q, gid))) return;
        const cfg = getSemCfg(gid);
        const cyc = [2, 3, 4, 5];
        cfg.max_warns = cyc[(cyc.indexOf(cfg.max_warns) + 1) % cyc.length] ?? 3;
        saveSemCfg(gid, cfg);
        const p = painelSemantico(gid); await edit(p.text, p.reply_markup);
        await bot.answerCallbackQuery(q.id, { text: `Avisos até punição final: ${cfg.max_warns}` }).catch(() => {});
        return;
      } else if (data.startsWith('ai_final:')) {
        const gid = data.split(':')[1];
        if (!(await canEdit(bot, q, gid))) return;
        const cfg = getSemCfg(gid);
        const cyc = ['ban', 'mute', 'deletar'];
        cfg.acao_final = cyc[(cyc.indexOf(cfg.acao_final) + 1) % cyc.length] ?? 'ban';
        saveSemCfg(gid, cfg);
        const p = painelSemantico(gid); await edit(p.text, p.reply_markup);
        await bot.answerCallbackQuery(q.id, { text: `Na última vez: ${cfg.acao_final}` }).catch(() => {});
        return;
      } else if (data.startsWith('ai_warnmsg:')) {
        const gid = data.split(':')[1];
        if (!(await canEdit(bot, q, gid))) return;
        const cfg = getSemCfg(gid); cfg.avisar_no_grupo = !cfg.avisar_no_grupo;
        saveSemCfg(gid, cfg);
        const p = painelSemantico(gid); await edit(p.text, p.reply_markup);
        return;
      } else if (data.startsWith('ai_del:')) {
        const gid = data.split(':')[1];
        if (!(await canEdit(bot, q, gid))) return;
        const cfg = getSemCfg(gid); cfg.deletar = !cfg.deletar;
        saveSemCfg(gid, cfg);
        const p = painelSemantico(gid); await edit(p.text, p.reply_markup);
        return;
      } else if (data.startsWith('ai_warn:')) {
        const gid = data.split(':')[1];
        if (!(await canEdit(bot, q, gid))) return;
        const cfg = getSemCfg(gid); cfg.warn = !cfg.warn;
        saveSemCfg(gid, cfg);
        const p = painelSemantico(gid); await edit(p.text, p.reply_markup);
        return;
      } else if (data.startsWith('ai_staff:')) {
        const gid = data.split(':')[1];
        if (!(await canEdit(bot, q, gid))) return;
        const cfg = getSemCfg(gid); cfg.punir_staff = !cfg.punir_staff;
        saveSemCfg(gid, cfg);
        const p = painelSemantico(gid); await edit(p.text, p.reply_markup);
        await bot.answerCallbackQuery(q.id, { text: cfg.punir_staff ? 'Modo teste ligado.' : 'Modo teste desligado.' }).catch(() => {});
        return;
      } else if (data.startsWith('ai_run:')) {
        // DISPARAR: revarre os últimos 61min do buffer na hora exata.
        const gid = data.split(':')[1];
        if (!(await canEdit(bot, q, gid))) return;
        await bot.answerCallbackQuery(q.id, { text: 'Disparando varredura agora…' }).catch(() => {});
        try {
          const res = await varreduraGrupo(bot, gid);
          const dicaAdmin = res.ignoradas
            ? ` ${res.ignoradas} msg(s) de admin ignorada(s) — para testar suas próprias mensagens, ligue "Admin no teste".`
            : '';
          const det = res.porNivel && (res.porNivel.severo || res.porNivel.medio)
            ? ` (🔴 ${res.porNivel.severo || 0} · 🟠 ${res.porNivel.medio || 0})` : '';
          if (res.erro) {
            await bot.sendMessage(q.message.chat.id, `▶️ ${res.erro}.`);
          } else if (res.n) {
            await bot.sendMessage(q.message.chat.id, `▶️ Disparo manual: ${res.n} mensagem(ns) tratada(s)${det}.${dicaAdmin}`);
          } else {
            await bot.sendMessage(q.message.chat.id, `▶️ Disparo manual: nada suspeito em ${res.janela}.${dicaAdmin}`);
          }
        } catch (e) {
          console.error('[callback:disparo]', e.message);
          await bot.sendMessage(q.message.chat.id, '▶️ Disparo falhou sem quebrar nada. Tente de novo.').catch(() => {});
        }
        const p = painelSemantico(gid); await edit(p.text, p.reply_markup).catch(() => {});
        return;
      } else if (data.startsWith('sem_treinar:')) {
        const gid = data.split(':')[1];
        if (!(await canEdit(bot, q, gid))) return;
        await bot.answerCallbackQuery(q.id).catch(() => {});
        retreinar(bot, q.message.chat.id, gid);
        return;
      } else if (data.startsWith('sem_tol:')) {
        // Nível 1: Baixo / Médio / Alto / Personalizar.
        const gid = data.split(':')[1];
        if (!(await canEdit(bot, q, gid))) return;
        const p = painelTolerancia(gid); await edit(p.text, p.reply_markup);
        return;
      } else if (data.startsWith('sem_tol_custom:')) {
        // Nível 2: grade 10-90.
        const gid = data.split(':')[1];
        if (!(await canEdit(bot, q, gid))) return;
        const p = painelTolNumeros(gid); await edit(p.text, p.reply_markup);
        return;
      } else if (data.startsWith('sem_tol_set:')) {
        // Salva o valor (preset ou número) e volta ao Antispam.
        const [, gid, val] = data.split(':');
        if (!(await canEdit(bot, q, gid))) return;
        const n = Number(val);
        if (!Number.isFinite(n) || n < 0 || n > 100) {
          await bot.answerCallbackQuery(q.id, { text: 'Valor inválido.' }).catch(() => {});
          return;
        }
        const cfg = getSemCfg(gid);
        cfg.tolerancia = Math.round(n);
        delete cfg.tolerancia_warn; delete cfg.tolerancia_ban;
        saveSemCfg(gid, cfg);
        const p = painelSemantico(gid); await edit(p.text, p.reply_markup);
        await bot.answerCallbackQuery(q.id, { text: `Tolerância: ${cfg.tolerancia}%` }).catch(() => {});
        return;
      } else if (data.startsWith('cens_ver:')) {
        const gid = data.split(':')[1];
        if (!(await canEdit(bot, q, gid))) return;
        await bot.sendMessage(q.message.chat.id, `📜 Regras do grupo:\n\n${getRegrasTexto(gid)}`);
        await bot.answerCallbackQuery(q.id).catch(() => {});
        return;
      } else if (data.startsWith('cens_editar:')) {
        const gid = data.split(':')[1];
        if (!(await canEdit(bot, q, gid))) return;
        setPendente(q.message.chat.id, q.from.id, { gid, tipo: 'censurar_regras' });
        await bot.sendMessage(q.message.chat.id, '✏️ Envie o NOVO texto das regras (mensagem única). Digite "cancelar" para desistir.');
        await bot.answerCallbackQuery(q.id).catch(() => {});
        return;
      } else if (data.startsWith('wl:')) {
        const gid = data.split(':')[1];
        if (!(await canEdit(bot, q, gid))) return;
        const p = painelWhitelist(gid); await edit(p.text, p.reply_markup);
        return;
      } else if (data.startsWith('wl_add_link:')) {
        const gid = data.split(':')[1];
        if (!(await canEdit(bot, q, gid))) return;
        setPendente(q.message.chat.id, q.from.id, { gid, tipo: 'wl_link' });
        await bot.sendMessage(q.message.chat.id, '🔗 Envie o domínio permitido (ex: exemplo.com). "cancelar" desiste.');
        await bot.answerCallbackQuery(q.id).catch(() => {});
        return;
      } else if (data.startsWith('wl_add_assunto:')) {
        const gid = data.split(':')[1];
        if (!(await canEdit(bot, q, gid))) return;
        setPendente(q.message.chat.id, q.from.id, { gid, tipo: 'wl_assunto' });
        await bot.sendMessage(q.message.chat.id, '💬 Envie o assunto permitido (ex: aviso da moderação). "cancelar" desiste.');
        await bot.answerCallbackQuery(q.id).catch(() => {});
        return;
      } else if (data.startsWith('wl_rm_link:')) {
        const [, gid, idx] = data.split(':');
        if (!(await canEdit(bot, q, gid))) return;
        removerWlItem(gid, 'link', idx);
        const p = painelWhitelist(gid); await edit(p.text, p.reply_markup);
        return;
      } else if (data.startsWith('wl_rm_assunto:')) {
        const [, gid, idx] = data.split(':');
        if (!(await canEdit(bot, q, gid))) return;
        removerWlItem(gid, 'assunto', idx);
        const p = painelWhitelist(gid); await edit(p.text, p.reply_markup);
        return;
      }
      await bot.answerCallbackQuery(q.id).catch(() => {});
    } catch (e) {
      console.error('[callback]', e.message);
    }
  });
}
