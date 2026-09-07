PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS subscribers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  game_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_subscribers_email_game
  ON subscribers (email, game_id);

CREATE TABLE IF NOT EXISTS date_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id TEXT NOT NULL,
  old_date TEXT,
  new_date TEXT NOT NULL,
  event_type TEXT NOT NULL,
  change_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_date_events_game_id
  ON date_events (game_id);
