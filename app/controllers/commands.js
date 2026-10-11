import { findOrCreateGroup, visibleGroupsFor } from '../models/group.js';
import { manageKeyboard, manageText, openPrivateKeyboard } from '../helpers/keyboards.js';
import { guard, senderIsAdmin, targetIsStaff, isAnonymousAdmin } from '../helpers/admin.js';
import { getProgressivoCfg } from './alfabetos.js';
import { getSemCfg, analisarTexto, julgarNucleo, retreinar } from './semantico.js';
import { getRegrasTexto, setRegrasTexto } from '../helpers/regras.js';
import { TOTAL_SINAIS } from '../helpers/sinais.js';
import { statsModelo } from '../helpers/classico.js';
import { getWhitelist } from '../helpers/whitelist.js';
import { db } from '../../config/database.js';

function getAlfaRaw(gid) {
  const row = db.prepare('SELECT data FROM settings WHERE group_id = ? AND module = ?').get(String(gid), 'alfabetos');
  return row ? JSON.parse(row.data) : {};
}

function saveAlfaRaw(gid, data) {
  db.prepare('UPDATE settings SET data = ?, updated_at = ? WHERE group_id = ? AND module = ?')
    .run(JSON.stringify(data), new Date().toISOString(), String(gid), 'alfabetos');
}

export function registerCommands(bot) {
  bot.onText(/\/start(?:\s+(.+))?/, async (msg) => {
    if (msg.chat.type === 'private') {
      const me = await bot.getMe();
      await bot.sendMessage(msg.chat.id, manageText(me.username),
        { reply_markup: manageKeyboard(await visibleGroupsFor(bot, msg.from.id)) });
    } else {
      await bot.sendMessage(msg.chat.id,
        'Requisito: bot como administrador do grupo, com permissões de banir, apagar, fixar e convidar.\nApós a configuração, use /settings.');
    }
  });

  bot.onText(/\/reload/, async (msg) => {
    if (msg.chat.type === 'private') {
      await bot.sendMessage(msg.chat.id, 'Use /reload dentro do grupo.');
      return;
    }
    findOrCreateGroup(msg.chat.id, msg.chat.title);
    await bot.sendMessage(msg.chat.id,
      `Lista de admins sincronizada para ${msg.chat.title}.\nUse /settings para configurar.`);
  });

  bot.onText(/\/(settings|config|pvtconfig)/, async (msg) => {
    if (msg.chat.type === 'private') {
      const me = await bot.getMe();
      await bot.sendMessage(msg.chat.id, manageText(me.username),
        { reply_markup: manageKeyboard(await visibleGroupsFor(bot, msg.from.id)) });
    } else {
      findOrCreateGroup(msg.chat.id, msg.chat.title);
      const me = await bot.getMe();
      const kb = openPrivateKeyboard(me.username);
      await bot.sendMessage(msg.chat.id,
        `CONFIGURAÇÕES\nGrupo: ${msg.chat.title}\nPara editar, abra no privado.`,
        kb ? { reply_markup: kb } : undefined);
    }
  });

  // /setlog — define o GRUPO DOS ADMs que recebe os logs de mute/ban (alfabetos).
  // Uso (dentro do grupo monitorado, como admin):
  //   /setlog                 → mostra config atual + ID deste grupo
  //   /setlog -100123...      → logs vão para esse grupo ADM
  //   /setlog aqui            → logs vão para este próprio grupo (teste)
  //   /setlog limpar          → volta a avisar só no privado dos admins
  bot.onText(/\/setlog(?:\s+(.+))?/, async (msg) => {
    await guard(bot, msg, async () => {
      findOrCreateGroup(msg.chat.id, msg.chat.title);
      const gid = String(msg.chat.id);
      const arg = (msg.text.split(/\s+/)[1] || '').trim();
      const raw = getAlfaRaw(gid);
      const prog = getProgressivoCfg(raw);

      if (!arg) {
        await bot.sendMessage(msg.chat.id,
          `🛡 Grupo ADM (logs de mute/ban)\n\n` +
          `Este grupo: <code>${gid}</code>\n` +
          `Destino atual: ${prog.admin_grupo_id ? `<code>${prog.admin_grupo_id}</code>` : 'não definido (aviso vai só no privado dos admins)'}\n` +
          `Log ligado: ${prog.log_no_admin_grupo ? 'SIM' : 'NÃO'}\n\n` +
          `Para definir:\n` +
          `• <code>/setlog -100XXX</code> — manda os logs para o grupo ADM com esse ID\n` +
          `• <code>/setlog aqui</code> — manda os logs para este próprio grupo (teste)\n` +
          `• <code>/setlog limpar</code> — remove o grupo ADM\n\n` +
          `Passo a passo: adicione o bot como admin NO grupo dos ADMs, copie o ID dele (com /chatid lá), e rode <code>/setlog ID</code> aqui.`,
          { parse_mode: 'HTML' });
        return;
      }
      if (/^limpar|off|remover$/i.test(arg)) {
        raw.admin_grupo_id = '';
        saveAlfaRaw(gid, raw);
        await bot.sendMessage(msg.chat.id, 'Grupo ADM removido. Os avisos voltam a ir só para o privado dos admins.');
        return;
      }
      let destino = arg;
      if (/^aqui$/i.test(arg)) destino = gid;
      if (!/^-?\d+$/.test(destino)) {
        await bot.sendMessage(msg.chat.id, 'ID inválido. Use o formato <code>/setlog -1001234567890</code> ou <code>/setlog aqui</code>.', { parse_mode: 'HTML' });
        return;
      }
      // valida que o bot está no grupo destino
      try {
        await bot.sendChatAction(destino, 'typing');
      } catch {
        await bot.sendMessage(msg.chat.id,
          `Não consegui falar no grupo <code>${destino}</code>.\nAdicione o bot lá como membro/admin e tente de novo.`,
          { parse_mode: 'HTML' });
        return;
      }
      raw.admin_grupo_id = String(destino);
      raw.log_no_admin_grupo = true;
      saveAlfaRaw(gid, raw);
      await bot.sendMessage(msg.chat.id, `Grupo ADM definido para <code>${destino}</code>. Mutes e bans serão logados lá.`, { parse_mode: 'HTML' });
      try {
        await bot.sendMessage(destino, `🛡 Este grupo agora recebe os logs de moderação (alfabetos) de <b>${msg.chat.title || gid}</b> (<code>${gid}</code>).`, { parse_mode: 'HTML' });
      } catch {}
    });
  });

  bot.onText(/\/chatid/, async (msg) => {
    await bot.sendMessage(msg.chat.id, `ID deste chat: <code>${msg.chat.id}</code>`, { parse_mode: 'HTML' });
  });

  // /regras — mostra as regras do grupo (qualquer membro, no grupo).
  bot.onText(/\/regras/, async (msg) => {
    if (msg.chat.type === 'private') {
      await bot.sendMessage(msg.chat.id, 'Use /regras dentro do grupo.');
      return;
    }
    findOrCreateGroup(msg.chat.id, msg.chat.title);
    await bot.sendMessage(msg.chat.id, `📜 Regras do grupo — ${msg.chat.title || ''}\n\n${getRegrasTexto(String(msg.chat.id))}`);
  });

  // /definir_regras — edita as regras (só admins, no grupo).
  // Uso: /definir_regras <novo texto> ou responda a uma mensagem com /definir_regras.
  bot.onText(/\/definir_regras(?:\s+([\s\S]+))?/, async (msg) => {
    await guard(bot, msg, async () => {
      const gid = String(msg.chat.id);
      const m = msg.text.match(/\/definir_regras(?:\s+([\s\S]+))?/);
      const texto = (m && m[1] ? m[1] : (msg.reply_to_message?.text || msg.reply_to_message?.caption || '')).trim();
      if (texto.length < 10) {
        await bot.sendMessage(msg.chat.id, 'Envie o texto novo: /definir_regras <texto> ou responda a uma mensagem com /definir_regras.');
        return;
      }
      findOrCreateGroup(msg.chat.id, msg.chat.title);
      const ok = setRegrasTexto(gid, texto);
      await bot.sendMessage(msg.chat.id, ok
        ? `📜 Regras atualizadas e conferidas (${texto.length} caracteres).`
        : '❌ Não consegui salvar agora. Tente de novo em instantes.');
    });
  });

  // /analise — analisa a mensagem respondida e diz se é spam (com %).
  // Se for spam, TOMA AÇÃO (apaga + warn na escada). Veredito vai no PRIVADO
  // (com a % mesmo quando NÃO é spam — mostra a confiança do modelo).
  bot.onText(/\/analise\b/, async (msg) => {
    await guard(bot, msg, async () => {
      const gid = String(msg.chat.id);
      const alvo = msg.reply_to_message;
      const texto = String(alvo?.text || alvo?.caption || '');
      if (!alvo || !texto) {
        await bot.sendMessage(msg.chat.id, 'Uso: responda a uma mensagem com /analise.');
        return;
      }
      findOrCreateGroup(msg.chat.id, msg.chat.title);
      const cfg = getSemCfg(gid);
      const a = analisarTexto(texto, cfg);
      const conf = Math.round((a.ft?.prob || 0) * 100);
      const nivel = a.nivel || 'limpo';
      const ehSpam = nivel === 'medio' || nivel === 'severo';
      let acaoTxt = 'nenhuma (não é spam — só registra se for 🟡)';
      let acaoAplicada = false;
      if (ehSpam) {
        const uid = alvo.from?.id;
        const arroba = alvo.from?.username ? `@${alvo.from.username}` : (alvo.from?.first_name || uid);
        let staff = false;
        try {
          staff = isAnonymousAdmin(alvo) || (uid && await targetIsStaff(bot, gid, uid));
        } catch {}
        if (staff && !cfg.punir_staff) {
          acaoTxt = 'não aplicada (alvo é admin — ligue "Admin no teste" para punir admins)';
        } else {
          try {
            const r = await julgarNucleo(bot, gid, msg.chat.title || gid, alvo.message_id, Number(uid), arroba, texto, cfg, false);
            acaoTxt = r?.acao || 'aplicada';
            acaoAplicada = true;
          } catch (e) { acaoTxt = `falhou: ${String(e?.message || e).slice(0, 80)}`; }
        }
      }
      const sinaisTxt = a.sinais.motivos.length ? `${a.sinais.motivos.join('; ')} (score ${a.sinais.score})` : `score ${a.sinais.score}`;
      const linhas = [
        `🔍 Análise`,
        `Veredito: ${ehSpam ? '🚫 SPAM' : (nivel === 'baixo' ? '🟡 suspeita leve (só log)' : '✅ limpo')}`,
        `Nível: ${nivel}`,
        `Confiança: ${conf}%`,
        `Motivo: ${a.motivo || '-'}`,
        `Sinais: ${sinaisTxt}`,
        `Ação: ${acaoTxt}`,
        `Mensagem: "${texto.slice(0, 200)}"`,
      ];
      const txt = linhas.join('\n');
      // privado do admin que pediu (fallback: no grupo)
      const alvoPv = msg.from?.id;
      if (alvoPv) { try { await bot.sendMessage(alvoPv, txt); return; } catch {} }
      await bot.sendMessage(msg.chat.id, txt);
    });
  });

  // /aistatus — motor local + resumo (sem menção a integração: tudo roda aqui).
  bot.onText(/\/aistatus/, async (msg) => {
    const st = statsModelo();
    let extra = '';
    if (msg.chat.type !== 'private') {
      findOrCreateGroup(msg.chat.id, msg.chat.title);
      const gid = String(msg.chat.id);
      const sem = getSemCfg(gid);
      const wl = getWhitelist(gid);
      extra = `\n\nAntispam: ${sem.enabled ? 'ligado' : 'desligado'}` +
        `\nNíveis: 🟡 log · 🟠 deletar+warn (até ${sem.max_warns}x) · 🔴 ban direto` +
        `\nWhitelist: ${wl.links.length} link(s), ${wl.assuntos.length} assunto(s)`;
    }
    await bot.sendMessage(msg.chat.id,
      `🛡 Motor local: ${TOTAL_SINAIS} sinais + fastText` +
      (st ? `\nTreinado em: ${st.em.slice(0, 10)} (${st.nSpam + st.nHam} exemplos, FP no ham: ${st.fpHam})` : '\nModelo: ainda não treinado') +
      extra);
  });

  // /sinais — teste a seco: responda a uma mensagem e veja nível/motivo (só admins, sem punir).
  bot.onText(/\/sinais/, async (msg) => {
    await guard(bot, msg, async () => {
      const gid = String(msg.chat.id);
      const texto = msg.reply_to_message?.text || msg.reply_to_message?.caption || '';
      if (!texto) {
        await bot.sendMessage(msg.chat.id, 'Uso: responda a uma mensagem com /sinais para ver a análise (sem punir).');
        return;
      }
      const cfg = getSemCfg(gid);
      const a = analisarTexto(texto, cfg);
      const linhas = [
        `🔍 Análise (sem punir):`,
        `Nível: ${a.nivel ? `${a.nivel} — ${a.motivo}` : 'limpo'}`,
        `Sinais: score ${a.sinais.score}${a.sinais.motivos.length ? ` (${a.sinais.motivos.join('; ')})` : ''}`,
        `Modelo local: ${a.ft.spam ? 'marcou' : 'não marcou'} (${Math.round(a.ft.prob * 100)}%)`,
      ];
      await bot.sendMessage(msg.chat.id, linhas.join('\n'));
    });
  });

  // /retreinar — retreina o modelo local com db/corpus (só admins).
  bot.onText(/\/retreinar/, async (msg) => {
    await guard(bot, msg, async () => {
      retreinar(bot, msg.chat.id, String(msg.chat.id));
    });
  });

  // /perdaoai — zera warns do antispam (sem:*) do usuário (reply, @ ou ID).
  // Também limpa restos legados (ai:*, censura:*).
  bot.onText(/\/perdaoai/, async (msg) => {
    await guard(bot, msg, async () => {
      const gid = String(msg.chat.id);
      let uid = msg.reply_to_message?.from?.id || null;
      let display = msg.reply_to_message?.from?.username ? `@${msg.reply_to_message.from.username}` : null;
      if (!uid) {
        const arg = (msg.text.split(/\s+/)[1] || '').trim().replace(/^@/, '');
        if (/^\d+$/.test(arg)) { uid = Number(arg); display = arg; }
        else if (arg) {
          try {
            const c = await bot.getChat(`@${arg}`);
            uid = c.id; display = `@${arg}`;
          } catch {
            await bot.sendMessage(msg.chat.id, 'Usuário não localizado. Responda à mensagem dele ou use /perdaoai @arroba ou /perdaoai ID.');
            return;
          }
        } else {
          await bot.sendMessage(msg.chat.id, 'Uso: responda à mensagem do usuário com /perdaoai, ou /perdaoai @arroba, ou /perdaoai ID.');
          return;
        }
      }
      const nSem = db.prepare(`SELECT COUNT(*) AS n FROM warns WHERE group_id = ? AND user_id = ? AND reason LIKE 'sem:%'`).get(gid, Number(uid))?.n || 0;
      db.prepare(`DELETE FROM warns WHERE group_id = ? AND user_id = ? AND (reason LIKE 'sem:%' OR reason LIKE 'ai:%' OR reason LIKE 'censura:%')`).run(gid, Number(uid));
      await bot.sendMessage(msg.chat.id, `Avisos do antispam de ${display || uid} zerados (${nSem}).`);
    });
  });

  // /perdao — zera os avisos de alfabeto de um usuário (reply, @ ou ID).
  // Ex: /perdao (reply) | /perdao @user | /perdao 123456
  bot.onText(/\/perdao/, async (msg) => {
    await guard(bot, msg, async () => {
      const gid = String(msg.chat.id);
      let uid = msg.reply_to_message?.from?.id || null;
      let display = msg.reply_to_message?.from?.username ? `@${msg.reply_to_message.from.username}` : null;
      if (!uid) {
        const arg = (msg.text.split(/\s+/)[1] || '').trim().replace(/^@/, '');
        if (/^\d+$/.test(arg)) { uid = Number(arg); display = arg; }
        else if (arg) {
          try {
            const c = await bot.getChat(`@${arg}`);
            uid = c.id; display = `@${arg}`;
          } catch {
            await bot.sendMessage(msg.chat.id, 'Usuário não localizado. Responda à mensagem dele ou use /perdao @arroba ou /perdao ID.');
            return;
          }
        } else {
          await bot.sendMessage(msg.chat.id, 'Uso: responda à mensagem do usuário com /perdao, ou /perdao @arroba, ou /perdao ID.');
          return;
        }
      }
      const antes = db.prepare(`SELECT COUNT(*) AS n FROM warns WHERE group_id = ? AND user_id = ? AND reason LIKE 'alfabeto:%'`).get(gid, Number(uid))?.n || 0;
      db.prepare(`DELETE FROM warns WHERE group_id = ? AND user_id = ? AND reason LIKE 'alfabeto:%'`).run(gid, Number(uid));
      await bot.sendMessage(msg.chat.id, `Avisos de alfabeto de ${display || uid} zerados (tinha ${antes}).`);
    });
  });

  // Módulos: alfabetos (/start /reload /settings /setlog /chatid /perdao)
  // + antispam semântico (/regras /definir_regras /aistatus /perdaoai /sinais /retreinar) — listener em semantico.js
}
