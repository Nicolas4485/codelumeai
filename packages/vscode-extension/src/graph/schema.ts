/**
 * Graph database schema (SQLite via sql.js).
 *
 * Lives as a string constant because sql.js's exec() takes raw SQL.
 * `CREATE ... IF NOT EXISTS` everywhere so loading an existing DB is a no-op.
 */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS files (
  path TEXT PRIMARY KEY,
  language TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  indexed_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS symbols (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  file TEXT NOT NULL,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  start_char INTEGER NOT NULL,
  end_char INTEGER NOT NULL,
  detail TEXT,
  parent_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file);
CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);

CREATE TABLE IF NOT EXISTS refs (
  to_symbol TEXT NOT NULL,
  from_file TEXT NOT NULL,
  from_line INTEGER NOT NULL,
  from_char INTEGER NOT NULL,
  PRIMARY KEY (to_symbol, from_file, from_line, from_char)
);
CREATE INDEX IF NOT EXISTS idx_refs_from ON refs(from_file, from_line);
CREATE INDEX IF NOT EXISTS idx_refs_to ON refs(to_symbol);

INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', '1');
`;

export const SCHEMA_VERSION = "1";
