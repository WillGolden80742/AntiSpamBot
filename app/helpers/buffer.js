// Buffer local de mensagens p/ varredura com janela (intervalo + 60s overlap).
// Motivo: o Bot API do Telegram NÃO entrega histórico arbitrário ("última 1h");
// o próprio bot grava o que vê estando online e a varredura lê desse buffer.
// Janela: 30s→90s, 1m→2m, 5m→6m, 15m→16m, 30m→31m, 1h→61m (+2h/6h/12h/24h idem).
// Teto: 150 msgs / ciclo (evita estouro de contexto e custo).
import { db } from '../../config/database.js';

export const OVERLAP_SEG = 60;
export const LOTE_MAX = 150;
export const RETENCAO_HORAS = 24;

export function garantirTabela() {
  db.exec(`CREATE TABLE IF NOT EXISTS messages_log (
    group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    message_id INTEGER NOT NULL,
    user_id INTEGER,
    texto TEXT DEFAULT '',
    criado_em DATETIME NOT NULL DEFAULT (datetime('now')),
    julgado_em DATETIME,
    PRIMARY KEY (group_id, message_id)
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_log_grupo_tempo ON messages_log(group_id, criado_em)`);
}

export function registrarMensagem(msg) {
  try {
    if (!msg?.chat || !['group', 'supergroup'].includes(msg.chat.type)) return;
    if (!msg.message_id) return;
    const texto = String(msg.text || msg.caption || '').slice(0, 2000);
    if (!texto || texto.startsWith('/')) return; // comandos fora do buffer
    garantirTabela();
    db.prepare(`INSERT OR IGNORE INTO messages_log (group_id, message_id, user_id, texto) VALUES (?,?,?,?)`)
      .run(String(msg.chat.id), Number(msg.message_id), Number(msg.from?.id || 0), texto);
  } catch {}
}

// Lê a janela [agora - (intervalo+60s), agora], só não-julgadas, ascendente.
export function lerJanela(gid, intervaloSeg) {
  try {
    garantirTabela();
    const janela = Math.max(30, Number(intervaloSeg) || 300) + OVERLAP_SEG;
    return db.prepare(
      `SELECT message_id, user_id, texto, criado_em FROM messages_log
       WHERE group_id = ? AND julgado_em IS NULL
         AND datetime(criado_em) >= datetime('now', ?)
       ORDER BY criado_em ASC LIMIT ?`
    ).all(String(gid), `-${Math.round(janela)} seconds`, LOTE_MAX);
  } catch { return []; }
}

export function marcarJulgadas(gid, ids = []) {
  try {
    if (!ids.length) return;
    garantirTabela();
    const chunk = 200;
    for (let i = 0; i < ids.length; i += chunk) {
      const fatia = ids.slice(i, i + chunk).map(Number);
      db.prepare(
        `UPDATE messages_log SET julgado_em = datetime('now')
         WHERE group_id = ? AND message_id IN (${fatia.map(() => '?').join(',')})`
      ).run(String(gid), ...fatia);
    }
  } catch {}
}

export function podar() {
  try {
    garantirTabela();
    db.prepare(`DELETE FROM messages_log WHERE datetime(criado_em) < datetime('now', ?)`).run(`-${RETENCAO_HORAS} hours`);
  } catch {}
}
