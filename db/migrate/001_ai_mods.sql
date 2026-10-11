-- 001_ai_mods.sql — varredura Antispam AI + Censurar + Whitelist
-- Roda via: sqlite3 db/grouphelp.db < db/migrate/001_ai_mods.sql
-- (idempotente: IF NOT EXISTS; pode rodar com o bot parado)
CREATE TABLE IF NOT EXISTS messages_log (
  group_id   TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  message_id INTEGER NOT NULL,
  user_id    INTEGER,
  texto      TEXT DEFAULT '',
  criado_em  DATETIME NOT NULL DEFAULT (datetime('now')),
  julgado_em DATETIME,
  PRIMARY KEY (group_id, message_id)
);
CREATE INDEX IF NOT EXISTS idx_log_grupo_tempo ON messages_log(group_id, criado_em);
