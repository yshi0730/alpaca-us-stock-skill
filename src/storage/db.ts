import Database from "better-sqlite3";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(__dirname, "../../data");

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;

  mkdirSync(DATA_DIR, { recursive: true });
  _db = new Database(resolve(DATA_DIR, "alpaca-skill.db"));
  _db.pragma("journal_mode = WAL");
  _db.pragma("foreign_keys = ON");

  migrate(_db);
  return _db;
}

function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS strategies (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      universe TEXT NOT NULL DEFAULT '[]',
      rules TEXT NOT NULL,
      risk_management TEXT,
      is_active INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS trades (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL,
      symbol TEXT NOT NULL,
      side TEXT NOT NULL,
      qty REAL NOT NULL,
      qty_text TEXT,
      price REAL,
      price_text TEXT,
      total REAL,
      total_text TEXT,
      strategy_id TEXT,
      status TEXT NOT NULL,
      filled_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      note TEXT
    );

    CREATE TABLE IF NOT EXISTS alert_rules (
      id TEXT PRIMARY KEY,
      symbol TEXT NOT NULL,
      condition TEXT NOT NULL,
      action TEXT NOT NULL,
      is_active INTEGER DEFAULT 1,
      last_triggered_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS alert_history (
      id TEXT PRIMARY KEY,
      rule_id TEXT NOT NULL,
      symbol TEXT NOT NULL,
      message TEXT NOT NULL,
      data TEXT,
      acknowledged INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS position_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      snapshot TEXT NOT NULL,
      total_equity REAL NOT NULL,
      total_pnl REAL NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS backtests (
      id TEXT PRIMARY KEY,
      strategy_id TEXT NOT NULL,
      config TEXT NOT NULL,
      result TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_trades_symbol ON trades(symbol);
    CREATE INDEX IF NOT EXISTS idx_trades_created ON trades(created_at);
    CREATE INDEX IF NOT EXISTS idx_alert_history_created ON alert_history(created_at);
    CREATE INDEX IF NOT EXISTS idx_position_snapshots_created ON position_snapshots(created_at);
  `);

  addColumnIfMissing(db, "trades", "qty_text", "TEXT");
  addColumnIfMissing(db, "trades", "price_text", "TEXT");
  addColumnIfMissing(db, "trades", "total_text", "TEXT");
}

function addColumnIfMissing(db: Database.Database, table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((c) => c.name === column)) {
    db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
  }
}

// Config helpers
export function getConfig(key: string): string | undefined {
  const db = getDb();
  const row = db.prepare("SELECT value FROM config WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

export function setConfig(key: string, value: string): void {
  const db = getDb();
  db.prepare(
    "INSERT INTO config (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
  ).run(key, value);
}
