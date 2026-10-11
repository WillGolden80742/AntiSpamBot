// Regras do grupo (texto exibido em /regras e usado como referência).
// Módulo 'regras' (novo); adota o texto legado de 'censurar' se existir.
import { db } from '../../config/database.js';
import { logEvent } from '../models/group.js';

export const REGRAS_PADRAO = '1. Proibido spam, flood e divulgação sem autorização.\n2. Proibido links suspeitos (apostas, pirâmide, phishing).\n3. Respeite o tema do grupo.';

function lerModulo(gid, mod) {
  try {
    const row = db.prepare('SELECT data FROM settings WHERE group_id = ? AND module = ?').get(String(gid), mod);
    return row ? JSON.parse(row.data) : null;
  } catch { return null; }
}

export function getRegrasTexto(gid) {
  const r = lerModulo(gid, 'regras');
  if (r && typeof r.texto === 'string' && r.texto.trim()) return r.texto.slice(0, 4000);
  const legado = lerModulo(gid, 'censurar');
  if (legado && typeof legado.regras_texto === 'string' && legado.regras_texto.trim()) {
    const t = legado.regras_texto.slice(0, 4000);
    try { setRegrasTexto(gid, t); } catch {}
    return t;
  }
  return REGRAS_PADRAO;
}

// Salva e confere a leitura (prova de gravação). Retorna true se grudou.
export function setRegrasTexto(gid, texto) {
  const t = String(texto || '').trim().slice(0, 4000);
  if (t.length < 10) return false;
  db.prepare(`INSERT INTO settings (group_id, module, data, updated_at) VALUES (?,?,?,?)
    ON CONFLICT(group_id, module) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`)
    .run(String(gid), 'regras', JSON.stringify({ texto: t }), new Date().toISOString());
  logEvent('regras_change', gid, null, { tamanho: t.length });
  try { return getRegrasTexto(gid) === t; } catch { return false; }
}
