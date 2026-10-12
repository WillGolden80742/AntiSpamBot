// Antispam semântico — 0 LLM, 0 rede, 0 chave. Juiz único em 3 camadas:
//   1) Whitelist (perdão: link/assunto permitido nem é julgado)
//   2) Regex com pesos → baixo/médio/severo (explicável, instantâneo)
//   3) fastText local (300 spam + 300 ham) com Bayes de reserva
// Fusão: severo SÓ via regex; modelo entra na escada (médio) se prob>=tolerância;
// baixo se (score>=1 OU prob>=tolerância-20, mín 30); senão limpo.
// Punição: baixo=só registra (silencioso) | médio/severo=deleta+warn na escada
// até a ação final. NENHUMA punição é direta — tudo passa por warn antes.
import { execFile } from 'node:child_process';
import { getModule, logEvent } from '../models/group.js';
import { ensureBotPerm, targetIsStaff, isAnonymousAdmin } from '../helpers/admin.js';
import { analisarSinais, TOTAL_SINAIS } from '../helpers/sinais.js';
import { classificar, statsModelo, reload as reloadClassico, temModelo } from '../helpers/classico.js';
import { registrarMensagem, lerJanela, marcarJulgadas, podar } from '../helpers/buffer.js';
import { getWhitelist, saveWhitelist, ehPermitido } from '../helpers/whitelist.js';
import { getRegrasTexto, setRegrasTexto } from '../helpers/regras.js';
import { getPendente, clearPendente } from '../helpers/pending.js';
import { notificarFalha } from '../helpers/falhas.js';
import { logNoGrupoADM } from './alfabetos.js';
import { db } from '../../config/database.js';

const FINAL_CYCLE = ['ban', 'mute', 'deletar'];
const FINAL_LABEL = { ban: 'Ban', mute: 'Mute (silenciar)', deletar: 'Apenas deletar' };
const NIVEL_EMOJI = { baixo: '🟡', medio: '🟠', severo: '🔴' };
// Tolerância (%) é escolhida em botões: Baixo/Médio/Alto ou Personalizar (10-90).
// É a prob. mínima do modelo p/ ENTRAR na escada de warn. Sem ban direto.
export const TOL_NIVEIS = { baixo: 50, medio: 65, alto: 80 };
export const TOL_NUMEROS = [10, 20, 30, 40, 50, 60, 70, 80, 90];

// Painel da tolerância: 3 presets + personalizar + voltar.
export function painelTolerancia(gid) {
  const cfg = getSemCfg(gid);
  const atual = cfg.tolerancia ?? 65;
  const marca = (v) => (v === atual ? '✅ ' : '');
  const head = `🎚 <b>Tolerância</b>\nAtual: <code>${atual}%</code>\n\nAté quanto deixa passar. Baixa = rigorosa (pune mais) · Alta = perdoa mais.`;
  const rows = [
    [{ text: `${marca(50)}🔴 Baixo (50%)`, callback_data: `sem_tol_set:${gid}:50` },
     { text: `${marca(65)}🟡 Médio (65%)`, callback_data: `sem_tol_set:${gid}:65` }],
    [{ text: `${marca(80)}🟢 Alto (80%)`, callback_data: `sem_tol_set:${gid}:80` },
     { text: '✏️ Personalizar', callback_data: `sem_tol_custom:${gid}` }],
    [{ text: '⬅️ Voltar p/ Antispam', callback_data: `ai:${gid}` }],
  ];
  return { text: head, reply_markup: { inline_keyboard: rows } };
}

// Grade 10-90 do personalizar.
export function painelTolNumeros(gid) {
  const atual = getSemCfg(gid).tolerancia ?? 65;
  const head = `🎚 <b>Tolerância personalizada</b>\nAtual: <code>${atual}%</code>\n\nToque o valor:`;
  const rows = [];
  for (let i = 0; i < TOL_NUMEROS.length; i += 3) {
    rows.push(TOL_NUMEROS.slice(i, i + 3).map((v) => ({
      text: `${v === atual ? '✅ ' : ''}${v}%`,
      callback_data: `sem_tol_set:${gid}:${v}`,
    })));
  }
  rows.push([{ text: '⬅️ Voltar', callback_data: `sem_tol:${gid}` }]);
  return { text: head, reply_markup: { inline_keyboard: rows } };
}

export function getSemCfg(gid) {
  let raw = null;
  try {
    const row = db.prepare('SELECT data FROM settings WHERE group_id = ? AND module = ?').get(String(gid), 'semantico');
    raw = row ? JSON.parse(row.data) : null;
  } catch {}
  if (!raw) {
    // adota o liga/desliga e punição do módulo antigo (uma vez)
    try {
      const row = db.prepare('SELECT data FROM settings WHERE group_id = ? AND module = ?').get(String(gid), 'antispam_ai');
      const a = row ? JSON.parse(row.data) : {};
      raw = {
        enabled: a.enabled, deletar: a.deletar, warn: a.warn, avisar_no_grupo: a.avisar_no_grupo,
        max_warns: a.max_warns, acao_final: a.acao_final, log_no_admin_grupo: a.log_no_admin_grupo,
        punir_staff: a.punir_staff,
      };
    } catch {}
    raw = raw || {};
  }
  return {
    enabled: raw.enabled ?? false,
    deletar: raw.deletar ?? true,
    warn: raw.warn ?? true,
    avisar_no_grupo: raw.avisar_no_grupo ?? true,
    max_warns: Math.min(5, Math.max(2, Number(raw.max_warns) || 3)),
    acao_final: FINAL_CYCLE.includes(raw.acao_final) ? raw.acao_final : 'ban',
    log_no_admin_grupo: raw.log_no_admin_grupo ?? true,
    punir_staff: raw.punir_staff ?? false,
    tolerancia: (() => { const v = Number(raw.tolerancia ?? raw.tolerancia_warn); return Number.isFinite(v) ? Math.min(100, Math.max(0, Math.round(v))) : 65; })(),
    modelo_min: (() => { const v = Number(raw.modelo_min); return Number.isFinite(v) ? Math.min(100, Math.max(50, Math.round(v))) : 90; })(),
  };
}

export function saveSemCfg(gid, cfg) {
  db.prepare(`INSERT INTO settings (group_id, module, data, updated_at) VALUES (?,?,?,?)
    ON CONFLICT(group_id, module) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`)
    .run(String(gid), 'semantico', JSON.stringify(cfg), new Date().toISOString());
  logEvent('settings_change', gid, null, { module: 'semantico' });
}

function onOff(v) { return v ? 'ligado' : 'desligado'; }
function onOffCurto(v) { return v ? 'ON' : 'OFF'; }
// escapa HTML do log (a mensagem do usuário pode conter <>&)
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// traduz o erro do Telegram em mensagem curta e clara (evita "bad request" cru)
function erroPunicaoAmigavel(d) {
  const raw = String(d || '');
  if (/administrator|remove chat owner|creator/i.test(raw)) return 'Usuário não pode ser banido (é administrador/dono)';
  if (/CHAT_ADMIN_REQUIRED|not enough rights|not enough|ADMIN_RIGHTS|rights/i.test(raw)) return 'Bot sem permissão de restringir neste grupo';
  if (/bad request|BAD_REQUEST|USER_ID_INVALID|PEER_ID_INVALID|user not found|PARTICIPANT_ID_INVALID|can't restrict self|not a member|PARTICIPANT/i.test(raw)) return 'Usuário não pode ser banido';
  return `Não foi possível punir (${raw.slice(0, 80)})`;
}

// ---- análise pura (sem efeitos) — usada pelo /sinais, /analise e pelo juiz ----
// As REGRAS (regex) mandam; o modelo local reforça E também age sozinho:
//   - severo/médio vêm do regex (padrões fortes).
//   - score>=1: o modelo ESCALA p/ médio se concordar; senão baixo.
//   - score==0: o modelo sozinho decide — pct>tolerância → médio; pct>=50 → baixo.
// Salvaguarda para mensagens benignas frequentes e avisos de membros sobre golpes
function ehAvisoOuConversaLegitima(texto) {
  const low = String(texto || '').toLowerCase();
  if (/fake.*(ad|giveaway)|falso.*(anuncio|sorteio)|golpe.*(cuidado|don't|be careful)|cuidado.*golpe/i.test(low)) return true;
  if (/enem\.inep\.gov\.br|rastreamento\.correios\.com\.br/i.test(low)) return true;
  if (/sem correntes e sem propaganda/i.test(low)) return true;
  if (/(ganhou|empatou|gan[oó]|empat[oó])\s+(de\s+novo|de\s+nuevo)/i.test(low)) return true;
  if (/d[aá] pra consultar o cpf|puedes comprobar el cpf|can you check the cpf/i.test(low)) return true;
  if (/renovar.*cnh|renew.*cnh/i.test(low)) return true;
  if (/tarjeta de registro de votante|voter (registration )?card/i.test(low)) return true;
  if (/income tax on.*(cell )?phone/i.test(low)) return true;
  if (/pip install -r requirements\.txt/i.test(low)) return true;
  if (/supports? http\/2/i.test(low)) return true;
  return false;
}

export function analisarTexto(texto, cfg = {}) {
  const tol = cfg.tolerancia ?? cfg.tolerancia_warn ?? 65;
  const sinais = analisarSinais(texto, 3, 6);
  let ft = { origem: 'off', prob: 0, spam: false };
  try { ft = classificar(texto); } catch { ft = { origem: 'off', prob: 0, spam: false }; }
  const pct = Math.round(ft.prob * 100);
  let nivel = null;
  let motivo = '';

  if (ehAvisoOuConversaLegitima(texto)) {
    return { sinais, ft, nivel: null, motivo: '' };
  }

  if (sinais.nivel === 'severo' || sinais.nivel === 'medio') {
    // o modelo VETA falso positivo do regex (ex.: aviso "não cliquem… é phishing",
    // cidade "Betim"): se ele tem certeza que é ham (pct baixo), vira só log (🟡).
    if (pct < 15) { nivel = 'baixo'; motivo = sinais.motivos[0]; }
    else { nivel = sinais.nivel; motivo = sinais.motivos[0]; }
  } else if (sinais.score >= 1) {
    if (pct > tol) { nivel = 'medio'; motivo = sinais.motivos[0] || 'conteúdo suspeito'; }
    else { nivel = 'baixo'; motivo = sinais.motivos[0] || 'sinal fraco'; }
  } else if (pct > (cfg.modelo_min ?? 95)) {
    nivel = 'medio'; motivo = 'conteúdo suspeito';
  } else if (pct >= 50) {
    nivel = 'baixo'; motivo = 'suspeita leve';
  }
  return { sinais, ft, nivel, motivo };
}

export function painelSemantico(gid) {
  const cfg = getSemCfg(gid);
  const wl = getWhitelist(gid);
  const regras = getRegrasTexto(gid);
  const previa = regras.length > 160 ? `${regras.slice(0, 160)}…` : regras;
  const st = statsModelo();
  const motor = st
    ? `✅ treinado (${st.nSpam + st.nHam} exemplos, precisão ${st.fasttextTest.replace(/\s+/g, ' ')})`
    : '⚠️ ainda não treinado — rode Retreinar';
  const head =
    `🛡 <b>Antispam</b> — ${onOff(cfg.enabled)}\n` +
    `Motor local: ${TOTAL_SINAIS} sinais + fastText. ${motor}\n` +
    `Critério: suas 📜 regras. Perdão: ✅ whitelist.\n\n` +
    `📜 <b>Regras</b>\n${previa}\n\n` +
    `📌 <b>Hoje</b>\n` +
    `└ Varredura: ${onOff(cfg.enabled)} (tempo real, a cada mensagem)\n` +
    `└ Níveis: 🟡 log · 🟠🔴 deletar+warn (até ${cfg.max_warns}x, sem direto)\n` +
    `└ Tolerância: modelo só conta ≥${cfg.tolerancia ?? 65}%\n` +
    `└ Na última: ${FINAL_LABEL[cfg.acao_final]}\n` +
    `└ Aviso no grupo: ${onOff(cfg.avisar_no_grupo)} | Teste c/ admins: ${onOff(cfg.punir_staff)}\n` +
    `└ Whitelist: ${wl.links.length} link(s), ${wl.assuntos.length} assunto(s)`;
  const rows = [
    [{ text: `🛡 Antispam: ${onOffCurto(cfg.enabled)}`, callback_data: `ai_tgl:${gid}` },
     { text: `⚠️ Avisos: ${cfg.max_warns}`, callback_data: `ai_max:${gid}` }],
    [{ text: `🚫 Final: ${FINAL_LABEL[cfg.acao_final]}`, callback_data: `ai_final:${gid}` },
     { text: `📢 Aviso no grupo: ${onOffCurto(cfg.avisar_no_grupo)}`, callback_data: `ai_warnmsg:${gid}` }],
    [{ text: `${cfg.deletar ? '✅' : '⬜'} Deletar`, callback_data: `ai_del:${gid}` },
     { text: `${cfg.warn ? '✅' : '⬜'} Warn`, callback_data: `ai_warn:${gid}` }],
    [{ text: `🧪 Admin no teste: ${onOffCurto(cfg.punir_staff)}`, callback_data: `ai_staff:${gid}` },
     { text: `🎚 Tolerância: ${cfg.tolerancia ?? 65}%`, callback_data: `sem_tol:${gid}` }],
    [{ text: `✅ Whitelist: ${wl.links.length} links, ${wl.assuntos.length} assuntos`, callback_data: `wl:${gid}` }],
    [{ text: '⬅️ Voltar', callback_data: `open:${gid}` }],
  ];
  return { text: head, reply_markup: { inline_keyboard: rows } };
}

// ---- warns 'sem:' ----
function contarSem(gid, uid) {
  try {
    return db.prepare(`SELECT COUNT(*) AS n FROM warns WHERE group_id = ? AND user_id = ? AND reason LIKE 'sem:%'`).get(String(gid), Number(uid))?.n || 0;
  } catch { return 0; }
}
function registrarSem(gid, uid, motivo, previa) {
  try {
    db.prepare('INSERT INTO warns (group_id, user_id, reason) VALUES (?,?,?)')
      .run(String(gid), Number(uid), `sem:${String(motivo || '').slice(0, 60)}:${String(previa || '').slice(0, 80)}`);
  } catch {}
}
function limparSem(gid, uid) {
  try { db.prepare(`DELETE FROM warns WHERE group_id = ? AND user_id = ? AND reason LIKE 'sem:%'`).run(String(gid), Number(uid)); } catch {}
}

async function ehStaff(bot, msg) {
  try {
    if (isAnonymousAdmin(msg)) return true;
    if (msg.from && await targetIsStaff(bot, msg.chat.id, msg.from.id)) return true;
  } catch {}
  return false;
}
function getAdminGrupo(gid) {
  try {
    const row = db.prepare('SELECT data FROM settings WHERE group_id = ? AND module = ?').get(String(gid), 'alfabetos');
    return String((row ? JSON.parse(row.data) : {}).admin_grupo_id || '').trim();
  } catch { return ''; }
}

// Núcleo: julga e pune. silencioso=true → sem avisos no grupo (Disparar resume no fim).
export async function julgarNucleo(bot, gid, titulo, mid, uid, arroba, texto, cfg, silencioso = false) {
  const previa = String(texto || '').slice(0, 180);
  const a = analisarTexto(texto, cfg);
  if (!a.nivel) return { nivel: null };
  const em = NIVEL_EMOJI[a.nivel];
  if (a.nivel === 'baixo') {
    logEvent('sem_log', gid, uid, { motivo: a.motivo, previa: previa.slice(0, 200) });
    return { nivel: 'baixo', motivo: a.motivo };
  }
  let deletou = false;
  if (cfg.deletar) { try { await bot.deleteMessage(gid, mid); deletou = true; } catch {} }
  let acao = '';
  let contaTxt = ''; // "Aviso 1/3 — faltam 2 para o mute" (só no grupo)
  const nomeFinal = cfg.acao_final === 'ban' ? 'o ban' : cfg.acao_final === 'mute' ? 'o mute' : 'a ação final';
  if (true) {
    // médio E severo sobem a MESMA escada de warns — nenhuma punição é direta.
    if (!cfg.warn) {
      acao = deletou ? 'DELETE' : 'DELETE falhou';
      logEvent('sem_delete', gid, uid, { motivo: a.motivo, deletou });
    } else {
      const antes = contarSem(gid, uid);
      const total = antes + 1;
      if (antes < cfg.max_warns) registrarSem(gid, uid, a.motivo, previa); // não acumula além do máximo
      if (total >= cfg.max_warns && cfg.acao_final !== 'deletar') {
        const dispTotal = Math.min(total, cfg.max_warns); // trava a exibição em max (ex: 5/5)
        const perm = await ensureBotPerm(bot, gid, 'can_restrict_members');
        if (perm.ok) {
          try {
            if (cfg.acao_final === 'ban') { await bot.banChatMember(gid, uid); acao = `BAN após ${dispTotal}/${cfg.max_warns}`; }
            else { await bot.restrictChatMember(gid, uid, { permissions: { can_send_messages: false } }); acao = `MUTE após ${dispTotal}/${cfg.max_warns}`; }
            logEvent(cfg.acao_final === 'ban' ? 'sem_ban' : 'sem_mute', gid, uid, { motivo: a.motivo });
            limparSem(gid, uid);
            contaTxt = `Registro ${dispTotal}/${cfg.max_warns} — ${nomeFinal} aplicado`;
          } catch (e) {
            const d = e?.response?.body?.description || e?.message || String(e);
            acao = erroPunicaoAmigavel(d);
            contaTxt = `Registro ${dispTotal}/${cfg.max_warns} — ${nomeFinal} NÃO aplicado`;
            console.error('[semantico] punição final falhou:', d);
          }
        } else {
          acao = 'Bot sem permissão de restringir neste grupo';
          contaTxt = `Registro ${dispTotal}/${cfg.max_warns} — ${nomeFinal} NÃO aplicado`;
        }
      } else {
        acao = `aviso ${total}/${cfg.max_warns}`;
        contaTxt = `Registro ${total}/${cfg.max_warns} — faltam ${cfg.max_warns - total} para ${nomeFinal}`;
        logEvent('sem_aviso', gid, uid, { motivo: a.motivo, total });
      }
    }
  }
  // Avisos: NO GRUPO só o motivo (nunca o trecho, nunca %).
  // Trecho + ação detalhada: só no privado (DM) e no log dos ADMs.
  const sitMsg = deletou ? 'mensagem apagada' : (cfg.deletar ? 'NÃO apagada (bot sem permissão?)' : 'mensagem mantida');
  const conf = Math.round((a.ft?.prob || 0) * 100);
  // Deixa claro de ONDE veio o nível: regras (score) e/ou modelo local.
  const sinaisTxt = a.sinais?.motivos?.length ? `${a.sinais.motivos.join('; ')} (score ${a.sinais.score})` : `score ${a.sinais?.score ?? 0}`;
  if (!silencioso && cfg.avisar_no_grupo) {
    try {
      await bot.sendMessage(gid, `${em} ${arroba}\nMotivo: ${a.motivo}\nAção feita: ${sitMsg}${contaTxt ? `\n${contaTxt}` : ''}`);
    } catch {}
  }
  const espelhou = await logNoGrupoADM(bot, { log_no_admin_grupo: cfg.log_no_admin_grupo, admin_grupo_id: getAdminGrupo(gid) },
    `${em} <b>Antispam</b> (${a.nivel})\nGrupo: ${esc(titulo)} (<code>${gid}</code>)\nUsuário: ${esc(arroba)} [<code>${uid}</code>]\nMotivo: ${esc(a.motivo)}\nSinais (regras): ${esc(sinaisTxt)}\nModelo local: ${conf}%\nMensagem: "${esc(previa)}"\nAção: <b>${esc(acao)}</b> (${esc(sitMsg)})`);
  if (!espelhou && a.nivel !== 'baixo') {
    try {
      const adms = await bot.getChatAdministrators(gid);
      for (const x of adms) {
        if (x?.user && !x.user.is_bot) {
          try { await bot.sendMessage(x.user.id, `${em} Antispam (${a.nivel})\nGrupo: ${titulo}\nUsuário: ${arroba} [${uid}]\nMotivo: ${a.motivo}\nSinais (regras): ${sinaisTxt}\nModelo local: ${conf}%\nMensagem: "${previa}"\nAção: ${acao} (${sitMsg})`); } catch {}
        }
      }
    } catch {}
  }
  return { nivel: a.nivel, motivo: a.motivo, acao };
}

export async function julgarMensagem(bot, msg) {
  const gid = String(msg?.chat?.id ?? '');
  try {
    if (!msg.chat || !['group', 'supergroup'].includes(msg.chat.type)) return;
    if (msg.from?.is_bot) return;
    const texto = String(msg.text || msg.caption || '');
    if (!texto || texto.startsWith('/')) return;
    registrarMensagem(msg);
    const cfg = getSemCfg(gid);
    if (!cfg.enabled) return;
    if (!temModelo()) { logEvent('sem_degraded', gid, msg.from?.id, { motivo: 'sem modelo' }); return; }
    const staff = await ehStaff(bot, msg);
    if (staff && !cfg.punir_staff) return;
    const wl = getWhitelist(gid);
    if (ehPermitido(texto, wl).permitido) { marcarJulgadas(gid, [msg.message_id]); return; }
    const arroba = msg.from.username ? `@${msg.from.username}` : (msg.from.first_name || msg.from.id);
    await julgarNucleo(bot, gid, msg.chat.title || gid, msg.message_id, Number(msg.from.id), arroba, texto, cfg, false);
    marcarJulgadas(gid, [msg.message_id]);
  } catch (e) {
    console.error('[semantico]', e.message);
    await notificarFalha(bot, gid, 'antispam', e.message);
  }
}

// Disparar: revarre os últimos 61min do buffer. Retorna contagens por nível.
export async function varreduraGrupo(bot, gid) {
  const cfg = getSemCfg(gid);
  const janela = 'últimos 61min';
  if (!cfg.enabled) return { n: 0, erro: null, janela, ignoradas: 0, porNivel: {} };
  const grupo = db.prepare('SELECT * FROM groups WHERE id = ?').get(String(gid));
  const titulo = grupo?.title || String(gid);
  const lote = lerJanela(gid, 3600);
  if (!lote.length) return { n: 0, erro: null, janela, ignoradas: 0, porNivel: {} };
  if (!temModelo()) return { n: 0, erro: 'modelo local ausente — rode Retreinar', janela, ignoradas: 0, porNivel: {} };
  const wl = getWhitelist(gid);
  const porNivel = {};
  let ignoradas = 0, n = 0;
  for (const m of lote) {
    try {
      if (ehPermitido(m.texto, wl).permitido) continue;
      const staff = await ehStaff(bot, { chat: { id: gid }, from: { id: m.user_id } }).catch(() => false);
      if (staff && !cfg.punir_staff) { ignoradas++; continue; }
      const r = await julgarNucleo(bot, gid, titulo, Number(m.message_id), Number(m.user_id), `id:${m.user_id}`, m.texto, cfg, true);
      if (r.nivel && r.nivel !== 'baixo') { n++; porNivel[r.nivel] = (porNivel[r.nivel] || 0) + 1; }
      else if (r.nivel === 'baixo') { porNivel.baixo = (porNivel.baixo || 0) + 1; }
    } catch (e) { console.error('[semantico:disparo]', e.message); }
  }
  marcarJulgadas(gid, lote.map((m) => m.message_id));
  return { n, erro: null, janela, ignoradas, porNivel };
}

// Retreinar: roda bin/treinar.js em background, recarrega e relata.
let ultimoTreino = 0;
export function retreinar(bot, chatId, gid) {
  const agora = Date.now();
  if (agora - ultimoTreino < 60 * 1000) {
    bot.sendMessage(chatId, '🔁 Treino recente demais. Aguarde 1 min.').catch(() => {});
    return;
  }
  ultimoTreino = agora;
  bot.sendMessage(chatId, '🔁 Retreinando modelo local (segundos)…').catch(() => {});
  execFile('node', [new URL('../../bin/treinar.js', import.meta.url).pathname], { timeout: 180000 }, async (err, stdout) => {
    try {
      reloadClassico();
      const st = statsModelo();
      if (err) {
        await bot.sendMessage(chatId, `❌ Treino falhou: ${String(err.message || err).slice(0, 160)}`);
        return;
      }
      try { logEvent('sem_treino', gid || '-', null, { fp: st?.fpHam }); } catch {}
      await bot.sendMessage(chatId, st
        ? `✅ Modelo retreinado: ${st.nSpam + st.nHam} exemplos, precisão ${String(st.fasttextTest).replace(/\s+/g, ' ')}, FP no ham: ${st.fpHam}.`
        : '✅ Treino concluído.');
    } catch {}
  });
}

export function registerSemantico(bot) {
  bot.on('message', async (msg) => { await julgarMensagem(bot, msg); });
  bot.on('edited_message', async (msg) => { await julgarMensagem(bot, msg); });
  // fluxos de texto no privado: editar regras / adicionar link / adicionar assunto
  bot.on('message', async (msg) => {
    try {
      if (msg.chat?.type !== 'private' || !msg.text) return;
      const p = getPendente(msg.chat.id, msg.from?.id);
      if (!p) return;
      const texto = String(msg.text).trim();
      if (/^cancelar$/i.test(texto)) { clearPendente(msg.chat.id, msg.from.id); await bot.sendMessage(msg.chat.id, 'Edição cancelada.'); return; }
      if (p.tipo === 'censurar_regras') {
        const ok = setRegrasTexto(p.gid, texto);
        clearPendente(msg.chat.id, msg.from.id);
        await bot.sendMessage(msg.chat.id, ok
          ? `📜 Regras atualizadas e conferidas (${texto.length} caracteres).`
          : '❌ Não consegui salvar agora. Tente de novo em instantes.');
      } else if (p.tipo === 'wl_link') {
        const wl = getWhitelist(p.gid);
        const dom = texto.toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').trim();
        if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(dom)) { await bot.sendMessage(msg.chat.id, 'Domínio inválido. Ex: exemplo.com (ou "cancelar").'); return; }
        if (!wl.links.includes(dom)) wl.links.push(dom);
        saveWhitelist(p.gid, wl);
        clearPendente(msg.chat.id, msg.from.id);
        await bot.sendMessage(msg.chat.id, getWhitelist(p.gid).links.includes(dom)
          ? `✅ Link permitido salvo: ${dom}.` : '❌ Não consegui salvar agora. Tente de novo em instantes.');
      } else if (p.tipo === 'wl_assunto') {
        if (texto.length < 3) { await bot.sendMessage(msg.chat.id, 'Assunto muito curto (ou "cancelar").'); return; }
        const item = texto.slice(0, 120);
        const wl = getWhitelist(p.gid);
        if (!wl.assuntos.includes(item)) wl.assuntos.push(item);
        saveWhitelist(p.gid, wl);
        clearPendente(msg.chat.id, msg.from.id);
        await bot.sendMessage(msg.chat.id, getWhitelist(p.gid).assuntos.includes(item)
          ? `✅ Assunto permitido salvo: "${item.slice(0, 80)}".` : '❌ Não consegui salvar agora. Tente de novo em instantes.');
      }
    } catch (e) { console.error('[semantico:edits]', e.message); }
  });
  podar();
}
