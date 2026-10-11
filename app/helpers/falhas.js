// Isolamento de falhas: um módulo quebrou (IA/ rede/ API) → avisa SÓ no privado
// dos admins, loga em events, e o resto do bot continua funcionando.
// - Nunca lança exceção (try/catch interno total).
// - Throttle: 1 aviso por módulo+grupo a cada 60min (evita flood no privado).
// - Chamadores: censurar, antispam_ai (varredura), ia_conexao.
import { logEvent } from '../models/group.js';

const ultimoAviso = new Map(); // `${gid}:${modulo}` → ts
const JANELA_MS = 60 * 60 * 1000;

export async function notificarFalha(bot, gid, modulo, erro) {
  try {
    const chave = `${gid}:${modulo}`;
    const agora = Date.now();
    if (agora - (ultimoAviso.get(chave) || 0) < JANELA_MS) return;
    ultimoAviso.set(chave, agora);
    try { logEvent(`${modulo}_falha`, gid, null, { erro: String(erro || '').slice(0, 200) }); } catch {}
    let admins = [];
    try { admins = await bot.getChatAdministrators(gid); } catch { return; }
    const texto =
      `⚠️ <b>Falha isolada — ${modulo}</b>\n` +
      `Grupo: <code>${gid}</code>\n` +
      `Erro: ${String(erro || 'desconhecido').slice(0, 200)}\n\n` +
      `O resto do bot continua funcionando. Este aviso repete no máximo 1x/hora.`;
    for (const a of admins) {
      const u = a?.user;
      if (!u || u.is_bot) continue;
      try { await bot.sendMessage(u.id, texto, { parse_mode: 'HTML' }); } catch {}
    }
  } catch {}
}
