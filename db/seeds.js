// db/seeds.js — estilo Rails seeds (roda com: pnpm db:seed)
// SÓ alfabeto: garante 1 grupo exemplo + settings do módulo 'alfabetos'.
// Uso real: grupos são criados via /reload e /settings dentro do Telegram.
import { db } from '../config/database.js';
import { DEFAULT_SETTINGS } from '../app/helpers/defaults.js';

const upsertGroup = db.prepare(
  'INSERT INTO groups (id, title) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title');
const upsertSetting = db.prepare(
  'INSERT INTO settings (group_id, module, data) VALUES (?,?,?) ON CONFLICT(group_id, module) DO UPDATE SET data=excluded.data');

const seedGroups = [
  { id: '-1001001', title: 'Anarquia e Libertarianismo' },
];

for (const g of seedGroups) {
  upsertGroup.run(g.id, g.title);
  for (const [mod, def] of Object.entries(DEFAULT_SETTINGS)) {
    upsertSetting.run(g.id, mod, JSON.stringify({ ...def }));
  }
}
console.log(`Seeds OK: ${seedGroups.length} grupos em db/grouphelp.db`);
