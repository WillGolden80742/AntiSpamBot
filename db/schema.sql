-- AntiSpamBot — schema.sql (SQLite) — MÓDULOS: alfabetos + semantico + regras + whitelist
-- Banco: grouphelp.db
-- Tabelas: groups, settings (módulos 'alfabetos'|'semantico'|'regras'|'whitelist'), warns, events, messages_log
-- Arquivos: db/corpus/spam.json + db/corpus/nao_spam.json → db/fasttext/spam.ftz + db/bayes.json (modelos locais)
-- ============================================================

PRAGMA journal_mode = WAL;

-- Grupos monitorados
CREATE TABLE IF NOT EXISTS groups (
  id     TEXT PRIMARY KEY,          -- ex: -1001001
  title  TEXT NOT NULL              -- ex: Anarquia e Libertarianismo
);

-- Um registro por módulo por grupo
-- data (alfabetos) = JSON com {arabe..bengali, nao_ocidental, progressivo_enabled, max_warns,
--   acao_final, avisar_no_grupo, log_no_admin_grupo, admin_grupo_id, punir_staff}
-- data (antispam_ai) = JSON com {enabled, intervalo, sensibilidade, deletar, warn, avisar_no_grupo,
--   max_warns, acao_final, punir_staff, log_no_admin_grupo}
-- data (censurar) = JSON com {enabled, regras_texto, deletar, warn, aviso_ia_no_grupo,
--   max_warns, acao_final, punir_staff, log_no_admin_grupo}
-- data (whitelist) = JSON com {links: [], assuntos: []} — permitidos, furam a IA
-- data (ia_conexao) = JSON com {provedor, modelo, testado_em, ultimo_ok}
CREATE TABLE IF NOT EXISTS settings (
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  module   TEXT NOT NULL,           -- alfabetos|antispam_ai|censurar|whitelist|ia_conexao
  data     TEXT NOT NULL DEFAULT '{}',
  updated_at DATETIME NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (group_id, module)
);

-- Avisos progressivos dos filtros (reason prefixado por módulo p/ não misturar)
CREATE TABLE IF NOT EXISTS warns (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id   TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL,
  reason     TEXT DEFAULT '',
  created_at DATETIME NOT NULL DEFAULT (datetime('now'))
);

-- Buffer local de mensagens p/ varredura AI com janela (intervalo + 60s overlap).
-- O Bot API não entrega histórico: o próprio bot grava o que vê estando online.
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

-- Log de moderação dos filtros
CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT NOT NULL,         -- alfabeto_*|ai_*|censura_*|whitelist_*|settings_change
  group_id   TEXT NOT NULL,
  user_id    INTEGER,
  meta       TEXT DEFAULT '{}',
  created_at DATETIME NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_events_group ON events(group_id, created_at);
