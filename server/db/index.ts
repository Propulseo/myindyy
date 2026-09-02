import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveMinionsDbPath, ensureMinionsStateDirs } from '../paths.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const schema = readFileSync(join(__dirname, 'schema.sql'), 'utf-8');

ensureMinionsStateDirs();

const dbPath = resolveMinionsDbPath();

export function initializeDatabase(database: import('better-sqlite3').Database): void {
  database.pragma('journal_mode = WAL');
  database.pragma('foreign_keys = ON');
  database.exec(schema);

  ensureColumn(database, 'tasks', 'agent_provider', 'TEXT');
  ensureColumn(database, 'tasks', 'mission_kind', "TEXT NOT NULL DEFAULT 'interactive'");
  ensureColumn(database, 'mission_runs', 'session_confirmed_at', 'INTEGER');
  ensureColumn(database, 'mission_runs', 'occurrence_key', 'TEXT');
  ensureColumn(database, 'mission_runs', 'workdir', 'TEXT');
  ensureColumn(database, 'mission_runs', 'provenance_json', 'TEXT');
  ensureColumn(database, 'operator_commands', 'lease_owner', 'TEXT');
  ensureColumn(database, 'operator_commands', 'lease_expires_at', 'INTEGER');
  ensureColumn(database, 'operator_commands', 'attempt_count', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(database, 'operator_commands', 'next_attempt_at', 'INTEGER NOT NULL DEFAULT 0');
  database.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_mission_runs_occurrence_key
    ON mission_runs(occurrence_key)
    WHERE occurrence_key IS NOT NULL
  `);
}

function ensureColumn(
  database: import('better-sqlite3').Database,
  table: string,
  column: string,
  ddl: string,
): void {
  const info = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!info.some((row) => row.name === column)) {
    database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }
}

export function createDatabase(path: string): import('better-sqlite3').Database {
  const database = new Database(path);
  initializeDatabase(database);
  return database;
}

const db: import('better-sqlite3').Database = createDatabase(dbPath);

export default db;
