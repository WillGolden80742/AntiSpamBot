// Trava de dono — SÓ o dono adiciona o bot em grupos; grupo estranho = saída.
// Regras:
//   - OWNER_ID (env): ID numérico do dono no Telegram. Sem ele, a trava fica
//     DESLIGADA (tudo passa como antes) + aviso no log — para não travar o
//     bot antes de configurar. Descubra o seu falando com o bot no privado
//     com /chatid e coloque OWNER_ID=xxxx no .env.
//   - Bot adicionado num grupo: quem adicionou (msg.from) != dono → avisa e
//     sai na hora. Adicionado pelo dono → registra e libera o grupo.
//   - Rede de segurança: mensagem vinda de grupo sem acesso liberado por mais
//     de 5 min → sai e limpa o registro local. Grupos que já estavam no banco
//     no boot contam como do dono (legado). Mensagens de serviço (entrada,
//     pin, etc.) são ignoradas aqui — quem cuida delas é o gate de entrada.
//   - Edição de configs continua exigindo admin do grupo (canEdit/guard); como
//     o bot só permanece onde o dono colocou, só admins desses grupos editam.
import { db } from '../../config/database.js';
import { findOrCreateGroup, listGroups, logEvent } from '../models/group.js';

const OWNER_ID = String(process.env.OWNER_ID || '').trim();
const GRACA_MS = 5 * 60 * 1000;

let botId = 0;
const legado = new Set(); // grupos no banco no boot = do dono
const vistoEm = new Map(); // gid -> primeira vez visto sem acesso

export function donoId() { return OWNER_ID; }

function acessoRow(gid) {
  try {
    const row = db.prepare('SELECT data FROM settings WHERE group_id = ? AND module = ?').get(String(gid), 'acesso');
    return row ? JSON.parse(row.data) : null;
  } catch { return null; }
}

function marcarAcesso(gid, por) {
  const agora = new Date().toISOString();
  const data = JSON.stringify({ autorizado: true, adicionado_por: String(por), em: agora });
  const row = db.prepare('SELECT data FROM settings WHERE group_id = ? AND module = ?').get(String(gid), 'acesso');
  if (row) db.prepare('UPDATE settings SET data = ?, updated_at = ? WHERE group_id = ? AND module = ?').run(data, agora, String(gid), 'acesso');
  else db.prepare('INSERT INTO settings (group_id, module, data) VALUES (?,?,?)').run(String(gid), 'acesso', data);
}

function limparGrupo(gid) {
  try {
    db.prepare('DELETE FROM settings WHERE group_id = ?').run(String(gid));
    db.prepare('DELETE FROM groups WHERE id = ?').run(String(gid));
    db.prepare('DELETE FROM warns WHERE group_id = ?').run(String(gid));
  } catch {}
}

export function grupoAutorizado(gid) {
  const g = String(gid);
  if (legado.has(g)) return true;
  try { return acessoRow(g)?.autorizado === true; } catch { return false; }
}

function ehServico(msg) {
  return !!(msg.new_chat_members || msg.left_chat_member || msg.group_chat_created ||
    msg.supergroup_chat_created || msg.channel_chat_created || msg.migrate_to_chat_id ||
    msg.migrate_from_chat_id || msg.pinned_message);
}

async function sair(bot, gid, motivo) {
  try { await bot.sendMessage(gid, '🔒 Este bot é de uso privado do dono e não atua neste grupo. Saindo…'); } catch {}
  try { await bot.leaveChat(gid); } catch (e) { console.error('[acesso] sair falhou:', e.message); }
  limparGrupo(String(gid));
  vistoEm.delete(String(gid));
  try { logEvent('acesso_saida', String(gid), null, { motivo }); } catch {}
  console.log(`[acesso] saí do grupo ${gid} (${motivo})`);
}

export function registerAcesso(bot) {
  try {
    for (const g of listGroups()) legado.add(String(g.id));
  } catch (e) { console.error('[acesso] legado:', e.message); }
  bot.getMe().then((me) => { botId = me.id; }).catch(() => {});
  if (!OWNER_ID) console.warn('[acesso] OWNER_ID não definido no .env — trava de dono DESLIGADA (tudo passa). Coloque OWNER_ID=seu_id e reinicie.');

  // Gate de entrada: bot adicionado a um grupo.
  bot.on('new_chat_members', async (msg) => {
    try {
      if (!OWNER_ID) return;
      if (!msg.chat || !['group', 'supergroup'].includes(msg.chat.type)) return;
      if (!botId) { try { botId = (await bot.getMe()).id; } catch { return; } }
      const euEntrei = (msg.new_chat_members || []).some((u) => u && u.id === botId);
      if (!euEntrei) return;
      const gid = String(msg.chat.id);
      const quem = msg.from?.id ? String(msg.from.id) : '';
      if (quem !== OWNER_ID) {
        await sair(bot, gid, `adicionado por ${quem || 'desconhecido'}`);
        return;
      }
      findOrCreateGroup(gid, msg.chat.title || 'Grupo');
      marcarAcesso(gid, quem);
      legado.add(gid);
      console.log(`[acesso] grupo ${gid} autorizado (adicionado pelo dono).`);
    } catch (e) { console.error('[acesso] entrada:', e.message); }
  });

  // Rede de segurança: mensagem de grupo sem acesso liberado há +5 min → sai.
  bot.on('message', async (msg) => {
    try {
      if (!OWNER_ID) return;
      if (!msg.chat || !['group', 'supergroup'].includes(msg.chat.type)) return;
      if (ehServico(msg)) return;
      const gid = String(msg.chat.id);
      if (grupoAutorizado(gid)) { vistoEm.delete(gid); return; }
      const agora = Date.now();
      if (!vistoEm.has(gid)) { vistoEm.set(gid, agora); return; }
      if (agora - vistoEm.get(gid) < GRACA_MS) return;
      await sair(bot, gid, 'sem acesso liberado');
    } catch (e) { console.error('[acesso] rede:', e.message); }
  });
}
