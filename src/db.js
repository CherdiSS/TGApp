import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id          INTEGER PRIMARY KEY,
  first_name  TEXT,
  blocked     INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS products (
  sku             TEXT PRIMARY KEY,
  title           TEXT,
  image           TEXT,
  price           INTEGER,
  card_price      INTEGER,
  available       INTEGER NOT NULL DEFAULT 1,
  last_checked_at INTEGER,
  next_check_at   INTEGER NOT NULL DEFAULT 0,
  fail_count      INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT
);

-- Точка пишется только при изменении цены или наличия.
CREATE TABLE IF NOT EXISTS price_history (
  id        INTEGER PRIMARY KEY,
  sku       TEXT NOT NULL REFERENCES products(sku) ON DELETE CASCADE,
  ts        INTEGER NOT NULL,
  price     INTEGER NOT NULL,
  available INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS price_history_sku_ts ON price_history (sku, ts);

CREATE TABLE IF NOT EXISTS trackings (
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sku            TEXT NOT NULL REFERENCES products(sku) ON DELETE CASCADE,
  target_price   INTEGER,
  added_price    INTEGER,
  baseline_price INTEGER,
  target_hit     INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  PRIMARY KEY (user_id, sku)
);
CREATE INDEX IF NOT EXISTS trackings_sku ON trackings (sku);
`;

export function openDb(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  return db;
}

export const now = () => Math.floor(Date.now() / 1000);

/** Цена, которую реально платит покупатель: с Ozon Картой, если она есть. */
export const effectivePrice = (p) => (p ? (p.card_price ?? p.price ?? null) : null);

export function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
