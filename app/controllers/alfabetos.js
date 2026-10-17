// Fiscalização de alfabetos — MULTISSELEÇÃO POR ALFABETO + MODO PROGRESSIVO (opcional):
// Cada alfabeto guarda um conjunto de flags: { deletar, silenciar, banir, progressivo }.
//   - flags IMEDIATAS (deletar/silenciar/banir): independentes, combináveis —
//     ex.: deletar+silenciar = apaga e silencia NA HORA; só silenciar = muta sem apagar.
//     NUNCA geram warn, NUNCA seguem o progressivo, mesmo com progressivo_enabled=true.
//   - 'progressivo' = segue o fluxo global: deleta + avisa max_warns X,
//     na última aplica acao_final (ban|mute|deletar) + loga no grupo dos ADMs.
//     É EXCLUSIVO com silenciar/banir imediatos (o fluxo progressivo manda na final).
//   - vazio (nada marcado) = DESATIVADO: ignora esse alfabeto.
// Formato antigo (string: 'desativado'|'deletar'|'silenciar+deletar'|'ban+deletar'|
// 'progressivo') é migrado automaticamente na leitura — nada precisa ser re-salvo à mão.
// Config em settings.alfabetos:
//   { arabe..bengali, nao_ocidental: selecao-por-alfabeto, progressivo_enabled, max_warns,
//     exceto_nao_ocidental: ['cirilico'] (scripts permitidos pelo catch-all "Não ocidental"),
//     acao_final: 'ban'|'mute'|'deletar' (vale SÓ p/ quem tem 'progressivo' marcado),
//     avisar_no_grupo, log_no_admin_grupo, admin_grupo_id,
//     punir_staff: true|false (MODO TESTE — se true, pune admin igual membro) }
// Se progressivo_enabled=false → quem tem 'progressivo' cai na ação final
// aplicada NA HORA (sem warns). Quem tem flags fixas continua igual.
// PRODUÇÃO (punir_staff=false): staff (admin/creator) é TOTALMENTE ignorado —
// sem delete, sem warn, sem aviso. MODO TESTE (punir_staff=true): pune admin igual membro.
import { spawn } from 'node:child_process';
import https from 'node:https';
import http from 'node:http';
import { getModule, logEvent } from '../models/group.js';
import { ensureBotPerm, targetIsStaff, isAnonymousAdmin } from '../helpers/admin.js';
import { salvarPerfilUsuario } from '../helpers/buffer.js';
import { db } from '../../config/database.js';

export const ALFA_REGEX = {
  arabe: /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]/,
  cirilico: /[\u0400-\u04FF\u0500-\u052F]/,
  chines: /[\u4E00-\u9FFF\u3400-\u4DBF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF]/,
  hindi: /[\u0900-\u097F]/,
  bengali: /[\u0980-\u09FF]/,
  // Catch-all "não ocidental": pega QUALQUER LETRA/NÚMERO fora do repertório ocidental/latino
  // (hebraico, grego, tailandês, coreano, etc.).
  // Emoji e símbolos sozinhos NUNCA punem: só contam se houver letra/número
  // de outro script junto (ver temLetraOuNumeroNaoOcidental abaixo).
  // Permitido = ASCII + blocos latinos + marcas de acentuação (texto ocidental normal).
  nao_ocidental: /[^\u0000-\u024F\u0300-\u036F\u1D00-\u1DBF\u1E00-\u1EFF\u2C60-\u2C7F\uA720-\uA7FF\uAB30-\uAB6F]/,
  // latim por último: quase tudo em português cai aqui — só pune se ativado
  latim: /[A-Za-z\u00C0-\u00FF]/,
};

// ordem de checagem: específicos primeiro, "não ocidental" como catch-all, latim por último
const CHECK_ORDER = ['arabe', 'cirilico', 'chines', 'hindi', 'bengali', 'nao_ocidental', 'latim'];

export const ALFA_NOME = {
  arabe: 'Árabe',
  cirilico: 'Cirílico',
  chines: 'Chinês',
  hindi: 'Hindi',
  bengali: 'Bengali',
  nao_ocidental: 'Não ocidental',
  latim: 'Latim',
};

const ALFA_KEYS = ['arabe', 'cirilico', 'chines', 'latim', 'hindi', 'bengali', 'nao_ocidental'];

// Alfabetos que podem ser marcados como EXCEÇÃO do catch-all "Não ocidental".
// Ex.: permitir Cirílico → russo passa, mas o resto do não ocidental segue bloqueado.
export const EXCETO_KEYS = ['arabe', 'cirilico', 'chines', 'hindi', 'bengali'];

// Normaliza a lista salva em settings.alfabetos.exceto_nao_ocidental.
export function normExcecoes(v) {
  if (!Array.isArray(v)) return [];
  return v.filter((k) => EXCETO_KEYS.includes(k));
}

// Remove do texto os caracteres dos scripts excepcionados (ex.: cirílico/russo).
function stripScripts(texto, excluidos) {
  let t = String(texto);
  for (const ex of excluidos) {
    t = t.replace(new RegExp(ALFA_REGEX[ex].source, 'g'), '');
  }
  return t;
}

// Letra ou número de qualquer script. \p{M} fica de fora de propósito:
// seletores de variação do emoji (ex.: U+FE0F) são Mn e não são "conteúdo".
const SOBRA_CONTEUDO = /[\p{L}\p{N}]/u;

// "Não ocidental" só vale se houver LETRA/NÚMERO de outro script no texto.
// Emoji, símbolos, pontuação e espaços sozinhos (ex.: "ótimo gosto 👍", "👍🎉")
// NÃO punem — o catch-all ignora e deixa passar.
function temLetraOuNumeroNaoOcidental(texto) {
  const t = String(texto || '');
  if (!ALFA_REGEX.nao_ocidental.test(t)) return false;
  const resto = [...t].filter((ch) => ALFA_REGEX.nao_ocidental.test(ch)).join('');
  return SOBRA_CONTEUDO.test(resto);
}

// Exceção do "Não ocidental": passa se, removidos os scripts permitidos,
// não sobrar NADA não ocidental com letra/número — ou se o que sobrar for só
// símbolo/emoji (sem letra/número de outro script).
// Ex.: russo + 🙂 passa; emoji sozinho sempre passa; hebraico bloqueia.
function passaNaExcecao(texto, excecoes) {
  const semExceto = stripScripts(texto, excecoes);
  if (!ALFA_REGEX.nao_ocidental.test(semExceto)) return true;
  const resto = [...semExceto].filter((ch) => ALFA_REGEX.nao_ocidental.test(ch)).join('');
  if (SOBRA_CONTEUDO.test(resto)) return false;
  return excecoes.some((ex) => ALFA_REGEX[ex].test(texto));
}

function normPunish(v) {
  if (v === 'progressivo' || v === 'progressive' || v === 'seguir_progressivo') return 'progressivo';
  if (v === 'deletar' || v === 'delete') return 'deletar';
  // legado: "silenciar" sozinho foi trocado por "deletar" (não fazia sentido:
  // mutava de primeira sem deletar e sem chance de warn)
  if (v === 'silenciar' || v === 'mute') return 'deletar';
  if (v === 'silenciar+deletar' || v === 'mute+delete' || v === 'delete+mute') return 'silenciar+deletar';
  if (v === 'ban+deletar' || v === 'ban' || v === 'kick' || v === 'banir') return 'ban+deletar';
  return 'desativado';
}

function normAcaoFinal(v) {
  if (v === 'mute' || v === 'silenciar' || v === 'silenciar+deletar') return 'mute';
  if (v === 'deletar' || v === 'delete' || v === 'apenas_deletar' || v === 'apenas deletar') return 'deletar';
  return 'ban';
}

// ---- multisseleção por alfabeto ----
// Normaliza qualquer formato salvo (string legada OU objeto novo) para o conjunto
// { deletar, silenciar, banir, progressivo }. Migração automática:
//   'desativado' → {} | 'deletar' → {deletar} | 'silenciar+deletar' → {deletar,silenciar}
//   'ban+deletar' → {deletar,banir} | 'progressivo' → {deletar,progressivo}
//   'silenciar'/'mute' sozinho (legado) → {silenciar} | 'ban' sozinho → {banir}
export function normSelecao(v) {
  const vazio = { deletar: false, silenciar: false, banir: false, progressivo: false };
  if (!v) return vazio;
  if (typeof v === 'object' && !Array.isArray(v)) {
    return {
      deletar: !!(v.deletar ?? v.delete),
      silenciar: !!(v.silenciar ?? v.mute),
      banir: !!(v.banir ?? v.ban ?? v.banir_user ?? v.kick),
      progressivo: !!(v.progressivo ?? v.progressive ?? v.seguir_progressivo),
    };
  }
  const s = normPunish(v);
  if (s === 'deletar') {
    // legado "silenciar/mute sozinho" vira {silenciar}; o resto vira {deletar}
    if (v === 'silenciar' || v === 'mute') return { ...vazio, silenciar: true };
    return { ...vazio, deletar: true };
  }
  if (s === 'silenciar+deletar') return { ...vazio, deletar: true, silenciar: true };
  if (s === 'ban+deletar') {
    // 'ban' puro (sem +deletar) = só banir, sem apagar
    if (v === 'ban' || v === 'kick' || v === 'banir') return { ...vazio, banir: true };
    return { ...vazio, deletar: true, banir: true };
  }
  if (s === 'progressivo') return { ...vazio, deletar: true, progressivo: true };
  return vazio;
}

// Tem alguma flag marcada? Vazio = desativado.
export function selecaoAtiva(sel) {
  const s = sel && typeof sel === 'object' ? sel : normSelecao(sel);
  return !!(s.deletar || s.silenciar || s.banir || s.progressivo);
}

// Defaults do modo progressivo (merge p/ grupos antigos sem essas chaves).
export function getProgressivoCfg(raw = {}) {
  return {
    progressivo_enabled: raw.progressivo_enabled ?? true,
    max_warns: Math.min(5, Math.max(2, Number(raw.max_warns) || 3)),
    acao_final: normAcaoFinal(raw.acao_final ?? 'ban'),
    avisar_no_grupo: raw.avisar_no_grupo ?? true,
    log_no_admin_grupo: raw.log_no_admin_grupo ?? true,
    admin_grupo_id: String(raw.admin_grupo_id || '').trim(),
    // MODO TESTE (punir staff): default false = produção (admin ignorado: sem delete, sem warn).
    // Ligue em /settings → Alfabetos → Punir staff: ON para testar punição em admins.
    punir_staff: raw.punir_staff ?? false,
    ler_imagens: raw.ler_imagens ?? false,
  };
}

export function detectarAlfabeto(texto) {
  if (!texto) return null;
  for (const k of CHECK_ORDER) {
    if (!ALFA_REGEX[k].test(texto)) continue;
    // emoji/símbolo puro nunca é "não ocidental"
    if (k === 'nao_ocidental' && !temLetraOuNumeroNaoOcidental(texto)) continue;
    return k;
  }
  return null;
}

// Igual a detectarAlfabeto, mas ignora categorias DESATIVADAS no grupo.
// É o que faz "nao_ocidental" atuar como catch-all: se o script específico
// (ex.: árabe) estiver desligado e "nao_ocidental" ligado, a mensagem cai nele.
// EXCEÇÕES: cfg.exceto_nao_ocidental lista scripts que o "Não ocidental" deve IGNORAR.
export function detectarAlfabetoAtivo(texto, cfg = {}) {
  if (!texto) return null;
  const excecoes = normExcecoes(cfg.exceto_nao_ocidental);
  for (const k of CHECK_ORDER) {
    if (!ALFA_REGEX[k].test(texto)) continue;
    // "Não ocidental" NUNCA pune emoji/símbolo puro: sem letra/número
    // de outro script, ignora e deixa passar (ex.: "ótimo gosto 👍").
    if (k === 'nao_ocidental' && !temLetraOuNumeroNaoOcidental(texto)) {
      continue;
    }
    // "Não ocidental" com exceções: ignora os scripts permitidos.
    if (k === 'nao_ocidental' && excecoes.length && passaNaExcecao(texto, excecoes)) {
      continue;
    }
    const sel = normSelecao(cfg[k]);
    if (!selecaoAtiva(sel)) continue;
    return { alfabeto: k, punicao: sel };
  }
  return null;
}

function displayUser(msg) {
  const u = msg.from;
  if (!u) return { arroba: 'desconhecido', nome: 'desconhecido', id: 0 };
  const arroba = u.username ? `@${u.username}` : (u.first_name || `id:${u.id}`);
  return { arroba, nome: u.first_name || arroba, id: u.id };
}

function trunc(s, n = 180) {
  if (!s) return '(sem texto)';
  const t = String(s).replace(/\n/g, ' ').slice(0, n);
  return t.length < String(s).length ? `${t}…` : t;
}

// ---- warns (tabela warns, reason prefixado p/ não misturar com warns manuais) ----
function contarWarnsAlfabeto(gid, uid) {
  try {
    const r = db.prepare(
      `SELECT COUNT(*) AS n FROM warns WHERE group_id = ? AND user_id = ? AND reason LIKE 'alfabeto:%'`
    ).get(String(gid), Number(uid));
    return r?.n || 0;
  } catch { return 0; }
}

function registrarWarnAlfabeto(gid, uid, alfabeto, previa) {
  try {
    db.prepare('INSERT INTO warns (group_id, user_id, reason) VALUES (?,?,?)')
      .run(String(gid), Number(uid), `alfabeto:${alfabeto}:${String(previa || '').slice(0, 120)}`);
  } catch (e) {
    console.error('[alfabetos] registrar warn falhou:', e.message);
  }
}

function limparWarnsAlfabeto(gid, uid) {
  try {
    db.prepare(`DELETE FROM warns WHERE group_id = ? AND user_id = ? AND reason LIKE 'alfabeto:%'`)
      .run(String(gid), Number(uid));
  } catch {}
}

// Avisa no PRIVADO do bot (DM p/ cada admin do grupo) + loga em events.
async function avisarPrivado(bot, gid, texto) {
  let admins = [];
  try {
    admins = await bot.getChatAdministrators(gid);
  } catch {
    return 0;
  }
  let ok = 0;
  for (const a of admins) {
    const u = a?.user;
    if (!u || u.is_bot) continue;
    try {
      await bot.sendMessage(u.id, texto);
      ok++;
    } catch {
      // admin nunca deu /start no bot → Telegram bloqueia DM, ignora
    }
  }
  return ok;
}

// Log espelhado no GRUPO DOS ADMs (admin_grupo_id configurado no painel ou /setlog).
// Retorna true se enviou, false se não há grupo configurado ou falhou.
export async function logNoGrupoADM(bot, cfgProg, texto) {
  if (!cfgProg.log_no_admin_grupo) return false;
  const logId = String(cfgProg.admin_grupo_id || '').trim();
  if (!logId) return false;
  try {
    await bot.sendMessage(logId, texto, { parse_mode: 'HTML' });
    return true;
  } catch (e) {
    console.error('[alfabetos] log no grupo ADM falhou:', e.message);
    return false;
  }
}

function formatarLogADM({ titulo, gid, arroba, nome, uid, nomeAlfa, previa, acao, detalhe, total, max }) {
  const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `🛡 <b>Log moderação — Alfabetos</b>\n` +
    `Grupo: ${esc(titulo)} (<code>${esc(gid)}</code>)\n` +
    `Usuário: ${esc(arroba)} (${esc(nome)}) [<code>${uid}</code>]\n` +
    `Alfabeto: ${esc(nomeAlfa)}\n` +
    `Ação: <b>${esc(acao)}</b>${total ? ` (${total}/${max})` : ''}\n` +
    `Mensagem: "${esc(String(previa).slice(0, 200))}"\n` +
    (detalhe ? `Detalhe: ${esc(detalhe)}` : '');
}

// Helper: verifica se o autor é staff. Anônimo (falando como grupo) conta como staff.
async function ehStaff(bot, msg) {
  try {
    if (isAnonymousAdmin(msg)) return true;
    if (msg.from && await targetIsStaff(bot, msg.chat.id, msg.from.id)) return true;
  } catch {}
  return false;
}

// Modo imediato multisseleção: cada flag age por conta própria —
// deletar apaga, silenciar muta, banir bane. Combináveis (deletar+silenciar,
// deletar+banir), ou sozinhos (só silenciar = muta sem apagar).
// Respeita avisar_no_grupo e log_no_admin_grupo. Nunca conta warns, nunca bane/muta
// além do marcado. Compatível com o formato antigo (string) via normSelecao.
async function aplicarSelecaoImediata(bot, msg, alfabeto, selRaw, cfgRaw) {
  const sel = normSelecao(selRaw);
  if (!selecaoAtiva(sel) || sel.progressivo) return true;
  const gid = msg.chat.id;
  const uid = msg.from.id;
  const prog = getProgressivoCfg(cfgRaw || {});
  const { arroba, nome, id } = displayUser(msg);
  const textoOriginal = msg.text || msg.caption || '';
  const previa = trunc(textoOriginal);
  const nomeAlfa = ALFA_NOME[alfabeto] || alfabeto;
  const titulo = msg.chat.title || gid;
  const staff = await ehStaff(bot, msg);
  const tagTeste = prog.punir_staff && staff ? ' [Modo teste: regra aplicada a administrador. Desativar em /settings → Alfabetos.]' : '';

  // 1. Deletar (se marcado)
  let deletou = false;
  let erroApi = '';
  if (sel.deletar) {
    try {
      await bot.deleteMessage(gid, msg.message_id);
      deletou = true;
    } catch (e) {
      erroApi = e?.response?.body?.description || e?.message || String(e);
      console.error('[alfabetos] delete falhou (multisselecao):', erroApi);
    }
  }

  // 2. Banir ou silenciar (ban tem prioridade — já remove o usuário)
  let fezRestricao = '';
  if (sel.banir || sel.silenciar) {
    const perm = await ensureBotPerm(bot, gid, 'can_restrict_members');
    if (!perm.ok) {
      if (prog.avisar_no_grupo) {
        try {
          await bot.sendMessage(gid,
          `⚠️ Mensagem em ${nomeAlfa} detectada (${arroba}). Punição não aplicada: bot sem permissão de restringir.\n` +
          `Ação necessária: conceder a permissão ao bot.${tagTeste}`);
        } catch {}
      }
      return !sel.deletar || deletou;
    }
    try {
      if (sel.banir) {
        await bot.banChatMember(gid, uid);
        fezRestricao = `bani ${arroba}`;
        try { limparWarnsAlfabeto(gid, uid); } catch {} // banir zera os warns
      } else {
        await bot.restrictChatMember(gid, uid, { permissions: { can_send_messages: false } });
        fezRestricao = `silenciei ${arroba}`;
      }
    } catch (e) {
      erroApi = [erroApi, e?.response?.body?.description || e?.message || String(e)].filter(Boolean).join(' | ');
      console.error('[alfabetos] punir falhou, vai avisar mesmo assim:', erroApi);
      if (!fezRestricao) fezRestricao = `tentei ${sel.banir ? 'banir' : 'silenciar'} ${arroba} mas o Telegram barrou`;
    }
  }

  const acoes = [
    sel.deletar ? (deletou ? 'mensagem apagada' : 'falha ao apagar') : null,
    fezRestricao || null,
  ].filter(Boolean).join(' + ') || 'sem ação';
  const punicaoHumana = [
    sel.deletar ? 'Deletar' : null,
    sel.banir ? 'Banir' : null,
    sel.silenciar && !sel.banir ? 'Silenciar' : null,
  ].filter(Boolean).join(' + ');
  logEvent('alfabeto_punicao', gid, uid, { alfabeto, sel, previa: previa.slice(0, 200), deletou });

  // SÓ APAGAR (só deletar marcado): aviso curto no grupo + log ADM.
  if (!sel.banir && !sel.silenciar) {
    logEvent('alfabeto_delete', gid, uid, { alfabeto, previa: previa.slice(0, 200), deletou, staff: !!staff });
    if (prog.avisar_no_grupo) {
      try {
        await bot.sendMessage(gid, deletou
          ? `🗑 Mensagem em ${nomeAlfa} removida (${arroba}).\n` +
            `Regra do grupo: apenas alfabeto ocidental.${tagTeste}`
          : `⚠️ Mensagem em ${nomeAlfa} detectada (${arroba}). Remoção não executada: bot sem permissão de apagar.${tagTeste}`);
      } catch (e) {
        erroApi = e?.response?.body?.description || e?.message || String(e);
      }
    }
    const logTxt = formatarLogADM({
      titulo, gid, arroba, nome, uid, nomeAlfa, previa,
      acao: 'DELETE (apenas deletar)',
      detalhe: deletou ? 'mensagem apagada, sem punição extra' : `falha ao apagar${erroApi ? `: ${erroApi}` : ''}`,
    });
    const espelhou = await logNoGrupoADM(bot, prog, logTxt);
    if (!espelhou) {
      await avisarPrivado(bot, gid,
        `🔤 Alfabetos — apenas deletado\nGrupo: ${titulo}\nUsuário: ${arroba} (${nome}) [${id}]\n` +
        `Alfabeto: ${nomeAlfa}\nMensagem: "${previa}"\nAção: mensagem ${deletou ? 'deletada' : 'NÃO deletada'} (sem ban/mute).`);
    }
    return deletou;
  }

  const modoTeste = tagTeste ? ` [Modo teste: regra aplicada a administrador.]` : '';
  const aviso =
    `🔤 Alfabetos — ação executada${modoTeste}\n` +
    `Grupo: ${titulo}\n` +
    `Usuário: ${arroba} (${nome}) [${id}]\n` +
    `Alfabeto: ${nomeAlfa}\n` +
    `Punição: ${punicaoHumana}\n` +
    `Mensagem: "${previa}"\n` +
    `Ação: ${sel.deletar ? `mensagem ${deletou ? 'apagada' : 'NÃO apagada'} + ` : ''}${fezRestricao}` +
    (erroApi ? `\nObs: Telegram retornou: ${erroApi}` : '') +
    `\nDetalhe: ${acoes}`;

  await avisarPrivado(bot, gid, aviso);
  return !sel.deletar || deletou;
}

// Compat: formato antigo (string) cai na multisseleção via normSelecao.
async function aplicarPunicaoImediata(bot, msg, alfabeto, punicao, cfgRaw) {
  return aplicarSelecaoImediata(bot, msg, alfabeto, punicao, cfgRaw);
}

// Modo progressivo: sempre deleta + avisa; no max_warns bane (ou muta, ou só deleta se acao_final=deletar).
// Staff só chega aqui com MODO TESTE ligado (isenção total no listener).
async function aplicarProgressivo(bot, msg, alfabeto, cfgRaw) {
  const gid = msg.chat.id;
  const uid = msg.from?.id;
  const prog = getProgressivoCfg(cfgRaw);
  const { arroba, nome, id } = displayUser(msg);
  const textoOriginal = msg.text || msg.caption || '';
  const previa = trunc(textoOriginal);
  const nomeAlfa = ALFA_NOME[alfabeto] || alfabeto;
  const titulo = msg.chat.title || String(gid);
  const staff = await ehStaff(bot, msg);
  const tagTeste = prog.punir_staff && staff ? ' [Modo teste: regra aplicada a administrador. Desativar em /settings → Alfabetos.]' : '';

  // APENAS DELETAR global (acao_final=deletar): só apaga + avisa + loga, nunca bane/muta, sem contar warns.
  if (prog.acao_final === 'deletar') {
    let deletou = false;
    let erroApi = '';
    try {
      await bot.deleteMessage(gid, msg.message_id);
      deletou = true;
    } catch (e) {
      erroApi = e?.response?.body?.description || e?.message || String(e);
      console.error('[alfabetos] delete falhou (apenas deletar):', erroApi);
    }
    logEvent('alfabeto_delete', gid, uid, { alfabeto, previa: previa.slice(0, 200), deletou, staff: !!staff });
    if (prog.avisar_no_grupo) {
      try {
        await bot.sendMessage(gid, deletou
          ? `🗑 Mensagem em ${nomeAlfa} removida (${arroba}). Apenas remoção, sem punição.\n` +
            `Trecho: "${previa}"${tagTeste}`
          : `⚠️ Mensagem em ${nomeAlfa} detectada (${arroba}). Remoção não executada: bot sem permissão de apagar.${tagTeste}`);
      } catch (e) {
        erroApi = e?.response?.body?.description || e?.message || String(e);
      }
    }
    const logTxt = formatarLogADM({
      titulo, gid, arroba, nome, uid, nomeAlfa, previa,
      acao: 'DELETE (apenas deletar)',
      detalhe: deletou ? 'mensagem apagada, sem punição extra' : `falha ao apagar${erroApi ? `: ${erroApi}` : ''}`,
    });
    const espelhou = await logNoGrupoADM(bot, prog, logTxt);
    if (!espelhou) {
      await avisarPrivado(bot, gid,
        `🔤 Alfabetos — apenas deletado\nGrupo: ${titulo}\nUsuário: ${arroba} (${nome}) [${id}]\n` +
        `Alfabeto: ${nomeAlfa}\nMensagem: "${previa}"\nAção: mensagem ${deletou ? 'deletada' : 'NÃO deletada'} (sem ban/mute).`);
    }
    return deletou;
  }

  // 1. SEMPRE deleta primeiro
  let deletou = false;
  try {
    await bot.deleteMessage(gid, msg.message_id);
    deletou = true;
  } catch (e) {
    console.error('[alfabetos] delete falhou:', e.message);
  }

  const anteriores = contarWarnsAlfabeto(gid, uid);
  const total = anteriores + 1;
  const ehUltimo = total >= prog.max_warns;

  let erroApi = '';
  let acaoHumana = '';

  if (!ehUltimo) {
    // ---- aviso 1..max-1: só deleta + avisa ----
    registrarWarnAlfabeto(gid, uid, alfabeto, previa);
    acaoHumana = `Aviso ${total}/${prog.max_warns} (mensagem deletada)`;
    logEvent('alfabeto_aviso', gid, uid, { alfabeto, aviso: total, max: prog.max_warns, previa: previa.slice(0, 200), deletou, staff: !!staff });

    if (prog.avisar_no_grupo) {
      try {
        await bot.sendMessage(gid, deletou
          ? `⚠️ Mensagem em ${nomeAlfa} removida (${arroba}).\n` +
            `Registro ${total}/${prog.max_warns}. Na ocorrência ${prog.max_warns}, aplica-se ${prog.acao_final === 'ban' ? 'banimento' : 'restrição de envio'}.\n` +
            `Trecho: "${previa}"${tagTeste}`
          : `⚠️ Mensagem em ${nomeAlfa} detectada (${arroba}). Remoção não executada: bot sem permissão de apagar.\n` +
            `Registro ${total}/${prog.max_warns}.\n` +
            `Trecho: "${previa}"${tagTeste}`);
      } catch (e) {
        erroApi = e?.response?.body?.description || e?.message || String(e);
        console.error('[alfabetos] aviso no grupo falhou:', erroApi);
      }
    }

    const logTxt = formatarLogADM({
      titulo, gid, arroba, nome, uid, nomeAlfa, previa,
      acao: `DELETE + AVISO ${total}/${prog.max_warns}`,
      detalhe: deletou ? 'mensagem apagada' : `falha ao apagar${erroApi ? `: ${erroApi}` : ''}`,
      total, max: prog.max_warns,
    });
    const espelhou = await logNoGrupoADM(bot, prog, logTxt);
    if (!espelhou) {
      await avisarPrivado(bot, gid,
        `🔤 Alfabetos — aviso ${total}/${prog.max_warns}\nGrupo: ${titulo}\nUsuário: ${arroba} (${nome}) [${id}]\n` +
        `Alfabeto: ${nomeAlfa}\nMensagem: "${previa}"\nAção: mensagem ${deletou ? 'deletada' : 'NÃO deletada'} + aviso no grupo.`);
    }
    return deletou;
  }

  // ---- última: deleta + ban (ou mute) + log ----
  registrarWarnAlfabeto(gid, uid, alfabeto, previa);
  const perm = await ensureBotPerm(bot, gid, 'can_restrict_members');
  if (!perm.ok) {
    if (prog.avisar_no_grupo) {
      try {
        await bot.sendMessage(gid,
          `⚠️ Limite de registros atingido (${arroba}): ${total}/${prog.max_warns} por mensagens em ${nomeAlfa}. Punição não aplicada: bot sem permissão de restringir.\n` +
          `Ação necessária: conceder a permissão ao bot.`);
      } catch {}
    }
    return deletou;
  }
  let fez = '';
  try {
    if (prog.acao_final === 'ban') {
      await bot.banChatMember(gid, uid);
      fez = `bani ${arroba}`;
      acaoHumana = `BAN após ${total}/${prog.max_warns} avisos`;
      logEvent('alfabeto_ban', gid, uid, { alfabeto, avisos: total, previa: previa.slice(0, 200) });
    } else {
      await bot.restrictChatMember(gid, uid, { permissions: { can_send_messages: false } });
      fez = `silenciei ${arroba}`;
      acaoHumana = `MUTE após ${total}/${prog.max_warns} avisos`;
      logEvent('alfabeto_mute', gid, uid, { alfabeto, avisos: total, previa: previa.slice(0, 200) });
    }
    limparWarnsAlfabeto(gid, uid); // zera contador após punição final
  } catch (e) {
    erroApi = e?.response?.body?.description || e?.message || String(e);
    console.error('[alfabetos] punição final falhou (modo teste):', erroApi);
    if (!fez) fez = `tentei ${prog.acao_final} em ${arroba} mas o Telegram barrou`;
    acaoHumana = `${prog.acao_final === 'ban' ? 'BAN' : 'MUTE'} após ${total}/${prog.max_warns} avisos (falha API)`;
    logEvent(prog.acao_final === 'ban' ? 'alfabeto_ban' : 'alfabeto_mute', gid, uid,
      { alfabeto, avisos: total, previa: previa.slice(0, 200), erro: erroApi });
  }

  if (prog.avisar_no_grupo) {
    try {
        await bot.sendMessage(gid,
          prog.acao_final === 'ban'
            ? `🚫 Banimento aplicado (${arroba}). Motivo: ${prog.max_warns} registros de mensagens em ${nomeAlfa}.\n` +
              `Último trecho: "${previa}"${tagTeste}`
            : `🚫 Envio restrito (${arroba}). Motivo: ${prog.max_warns} registros de mensagens em ${nomeAlfa}.\n` +
              `Último trecho: "${previa}"${tagTeste}`);
    } catch {}
  }

  const logTxt = formatarLogADM({
    titulo, gid, arroba, nome, uid, nomeAlfa, previa,
    acao: prog.acao_final === 'ban' ? 'DELETE + BAN (último aviso)' : 'DELETE + MUTE (último aviso)',
    detalhe: `${fez}${erroApi ? ` | API: ${erroApi}` : ''}`,
    total: prog.max_warns, max: prog.max_warns,
  });
  const espelhou = await logNoGrupoADM(bot, prog, logTxt);
  if (!espelhou) {
    await avisarPrivado(bot, gid,
      `🔤 Alfabetos — ${acaoHumana}${tagTeste}\n` +
      `Grupo: ${titulo}\nUsuário: ${arroba} (${nome}) [${id}]\nAlfabeto: ${nomeAlfa}\n` +
      `Mensagem: "${previa}"\nAção: ${fez}` +
      (erroApi ? `\nObs: Telegram retornou: ${erroApi}` : '') +
      `\n\nDica: configure o grupo dos ADMs no painel (Alfabetos → Grupo ADM) ou com /setlog para receber esses logs num grupo.`);
  }
  return deletou;
}

async function aplicarPunicao(bot, msg, alfabeto, punicao, cfgRaw) {
  // Multisseleção: flags fixas (deletar/silenciar/banir) SEMPRE imediatas, NUNCA
  // entram no progressivo — mesmo com progressivo_enabled=true. É o que garante
  // que "só apagar" nunca gera warn, nunca bane/muta.
  // 'progressivo' marcado = único que segue o fluxo global (warns + ação final).
  // Retorna true se apagou (ou se nem precisava apagar), false se o delete falhou.
  const sel = normSelecao(punicao);
  if (!selecaoAtiva(sel)) return true;
  if (sel.progressivo) {
    const prog = getProgressivoCfg(cfgRaw || {});
    if (prog.progressivo_enabled) {
      return aplicarProgressivo(bot, msg, alfabeto, cfgRaw);
    }
    // Progressivo com chave global desligada: une a ação final NA HORA (sem warns)
    // com o que já estava marcado — sem nunca perder a escolha do admin.
    const efetiva = {
      deletar: true,
      silenciar: sel.silenciar || prog.acao_final === 'mute',
      banir: sel.banir || prog.acao_final === 'ban',
      progressivo: false,
    };
    return aplicarSelecaoImediata(bot, msg, alfabeto, efetiva, cfgRaw);
  }
  return aplicarSelecaoImediata(bot, msg, alfabeto, sel, cfgRaw);
}

// Executa o Tesseract no buffer da imagem para extrair texto
export function extrairTextoImagem(buffer, langs = 'por+eng+rus+ara+chi_sim+chi_tra+hin+ben+jpn+kor+tha+heb+ell') {
  return new Promise((resolve) => {
    if (!buffer || !buffer.length) return resolve('');
    const child = spawn('tesseract', ['stdin', 'stdout', '-l', langs, '--psm', '11'], {
      stdio: ['pipe', 'pipe', 'ignore'],
    });

    let stdout = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });

    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      resolve('');
    }, 15000);

    child.on('close', (code) => {
      clearTimeout(timer);
      const res = (stdout || '').trim();
      console.log(`[alfabetos:ocr] Tesseract finalizado (code ${code}), texto extraído: "${res.slice(0, 100)}"`);
      resolve(res);
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      console.error('[alfabetos:ocr] Erro no processo tesseract:', err.message);
      resolve('');
    });

    try {
      child.stdin.end(buffer);
    } catch {
      clearTimeout(timer);
      resolve('');
    }
  });
}

// Baixa o arquivo do Telegram em memória via link gerado pelo bot
async function baixarBufferImagem(bot, fileId) {
  try {
    const fileLink = await bot.getFileLink(fileId);
    console.log(`[alfabetos:ocr] Baixando imagem de: ${fileLink.replace(/\/bot[^/]+/, '/bot***')}`);
    return await new Promise((resolve, reject) => {
      const client = fileLink.startsWith('https:') ? https : http;
      client.get(fileLink, (res) => {
        if (res.statusCode !== 200) {
          console.error(`[alfabetos:ocr] Download retornou status HTTP ${res.statusCode}`);
          res.resume();
          return resolve(null);
        }
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          console.log(`[alfabetos:ocr] Imagem baixada com sucesso (${buf.length} bytes)`);
          resolve(buf);
        });
        res.on('error', reject);
      }).on('error', reject);
    });
  } catch (err) {
    console.error('[alfabetos:ocr] falha ao baixar imagem:', err.message);
    return null;
  }
}

// Corpo do fiscal — a MESMA regra do tempo real para enviadas e editadas.
// Retorna 'punido' | 'sem_regra' | 'ignorado' | 'erro'.
export async function verificarMensagemAlfabeto(bot, msg) {
  const gid = String(msg?.chat?.id ?? '');
  const mid = msg?.message_id;
  let resultado = 'ignorado';
  try {
    // só grupo/supergrupo
    if (!msg.chat || !['group', 'supergroup'].includes(msg.chat.type)) { resultado = 'ignorado'; }
    else if (msg.from?.is_bot) { resultado = 'ignorado'; }
    else {
      if (msg.from?.id) salvarPerfilUsuario(msg.from); // cache de nomes p/ lista de usuários
      let txt = String(msg.text || msg.caption || '').trim();
      // ignora comandos no texto direto (evita punir /settings etc. pelo latim)
      if (txt.startsWith('/')) { resultado = 'ignorado'; }
      else {
        const cfg = getModule(gid, 'alfabetos');
        if (!cfg) { resultado = 'sem_regra'; }
        else {
          // MODO TESTE desligado (produção): staff é TOTALMENTE ignorado —
          // nem apaga, nem conta warn, nem avisa. Limpa warns antigos do admin.
          let staffIgnorado = false;
          try {
            if (!getProgressivoCfg(cfg).punir_staff) {
              if (isAnonymousAdmin(msg)) { staffIgnorado = true; }
              else if (msg.from && await targetIsStaff(bot, msg.chat.id, msg.from.id)) {
                try { limparWarnsAlfabeto(gid, msg.from.id); } catch {}
                staffIgnorado = true;
              }
            }
          } catch {}
          if (staffIgnorado) { resultado = 'ignorado'; }
          else {
            const progCfg = getProgressivoCfg(cfg);

            // Verifica se a mensagem tem imagem (foto, documento de imagem ou sticker estático) e ler_imagens está ativo
            let temImagem = false;
            let fileId = null;
            if (progCfg.ler_imagens) {
              if (Array.isArray(msg.photo) && msg.photo.length > 0) {
                // Pega a foto de maior resolução disponível
                const foto = msg.photo[msg.photo.length - 1];
                fileId = foto.file_id;
                temImagem = true;
              } else if (msg.document && msg.document.mime_type && msg.document.mime_type.startsWith('image/')) {
                fileId = msg.document.file_id;
                temImagem = true;
              } else if (msg.sticker && !msg.sticker.is_animated && !msg.sticker.is_video && msg.sticker.file_id) {
                fileId = msg.sticker.file_id;
                temImagem = true;
              }
            }

            if (!txt && !temImagem) {
              resultado = 'ignorado';
            } else {
              // 1. Testa primeiro o texto direto se houver
              let hit = txt ? detectarAlfabetoAtivo(txt, cfg) : null;

              // 2. Se não detectou no texto (ou não havia texto) e tem imagem com ler_imagens ativo, executa OCR Tesseract
              if (!hit && temImagem && fileId) {
                const imgBuf = await baixarBufferImagem(bot, fileId);
                if (imgBuf) {
                  const textoOcr = await extrairTextoImagem(imgBuf);
                  if (textoOcr) {
                    hit = detectarAlfabetoAtivo(textoOcr, cfg);
                    if (hit) {
                      // Se punir via imagem, registra o texto extraído no objeto da mensagem para log/warn
                      msg._ocr_texto = textoOcr;
                      if (!msg.text && !msg.caption) {
                        msg.text = `[Imagem OCR]: ${textoOcr}`;
                      }
                    }
                  }
                }
              }

              if (!hit) {
                resultado = 'sem_regra';
              } else {
                await aplicarPunicao(bot, msg, hit.alfabeto, hit.punicao, cfg);
                resultado = 'punido';
              }
            }
          }
        }
      }
    }
  } catch (e) {
    console.error('[alfabetos]', e.message);
    resultado = 'erro';
  }
  return resultado;
}

export function registerAlfabetos(bot) {
  bot.on('message', async (msg) => {
    await verificarMensagemAlfabeto(bot, msg);
  });
  // Edição não passa pelo 'message' — verifica na hora, sem rotina periódica.
  bot.on('edited_message', async (msg) => {
    await verificarMensagemAlfabeto(bot, msg);
  });
}

export { ALFA_KEYS };
