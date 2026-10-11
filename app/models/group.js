// SÓ alfabeto: grupos + settings do módulo 'alfabetos' + log de eventos.
import { db } from '../../config/database.js';
import { DEFAULT_SETTINGS } from '../helpers/defaults.js';

export function findOrCreateGroup(id, title = 'Grupo') {
  let g = db.prepare('SELECT * FROM groups WHERE id = ?').get(String(id));
  if (!g) {
    db.prepare('INSERT INTO groups (id, title) VALUES (?,?)')
      .run(String(id), title);
    for (const [mod, data] of Object.entries(DEFAULT_SETTINGS)) {
      db.prepare('INSERT INTO settings (group_id, module, data) VALUES (?,?,?)')
        .run(String(id), mod, JSON.stringify(data));
    }
    g = db.prepare('SELECT * FROM groups WHERE id = ?').get(String(id));
  } else if (g.title !== title) {
    db.prepare('UPDATE groups SET title = ? WHERE id = ?').run(title, String(id));
    g.title = title;
  }
  // backfill: grupos antigos ganham as linhas dos módulos novos (antispam_ai, censurar, …)
  try {
    const tem = new Set(db.prepare('SELECT module FROM settings WHERE group_id = ?').all(String(id)).map((r) => r.module));
    for (const [mod, data] of Object.entries(DEFAULT_SETTINGS)) {
      if (!tem.has(mod)) {
        db.prepare('INSERT INTO settings (group_id, module, data) VALUES (?,?,?)')
          .run(String(id), mod, JSON.stringify(data));
      }
    }
  } catch {}
  return g;
}

export function listGroups() {
  return db.prepare('SELECT * FROM groups ORDER BY title').all();
}

// Só grupos onde o BOT é admin E o usuário é admin (verificação live via API).
// Grupos demo/saídos (bot fora ou sem acesso) são ocultados, não apagados.
export async function visibleGroupsFor(bot, userId) {
  const all = listGroups();
  let me;
  try {
    me = await bot.getMe();
  } catch {
    return [];
  }
  const isStaff = (m) => m && ['creator', 'administrator'].includes(m.status);
  const out = [];
  for (const g of all) {
    try {
      const [botM, userM] = await Promise.all([
        bot.getChatMember(g.id, me.id),
        bot.getChatMember(g.id, userId),
      ]);
      if (isStaff(botM) && isStaff(userM)) out.push(g);
    } catch {
      // bot fora do grupo, grupo apagado ou sem acesso: oculta
    }
  }
  return out;
}

export function getModule(groupId, mod) {
  const row = db.prepare('SELECT data FROM settings WHERE group_id = ? AND module = ?')
    .get(String(groupId), mod);
  return row ? JSON.parse(row.data) : null;
}

export function logEvent(kind, groupId, userId, meta = {}) {
  db.prepare('INSERT INTO events (kind, group_id, user_id, meta) VALUES (?,?,?,?)')
    .run(kind, String(groupId), userId ?? null, JSON.stringify(meta));
}
