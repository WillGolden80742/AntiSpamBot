import Database from 'better-sqlite3';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const DB_PATH = process.env.DB_PATH || join(root, 'db', 'grouphelp.db');

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const appSchema = join(root, 'app', 'schema.sql');
const dbSchema = join(root, 'db', 'schema.sql');
const schemaPath = existsSync(appSchema) ? appSchema : dbSchema;
if (existsSync(schemaPath)) {
  db.exec(readFileSync(schemaPath, 'utf-8'));
}
export { DB_PATH };
