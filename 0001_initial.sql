CREATE TABLE IF NOT EXISTS subscribers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  topics_json TEXT NOT NULL,
  events_json TEXT NOT NULL,
  frequency TEXT NOT NULL CHECK (frequency IN ('immediate', 'daily', 'weekly')),
  confirm_token TEXT NOT NULL UNIQUE,
  unsubscribe_token TEXT NOT NULL UNIQUE,
  confirmed INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  consent_at TEXT NOT NULL,
  confirmed_at TEXT,
  unsubscribed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS legislative_events (
  event_id TEXT PRIMARY KEY,
  change_type TEXT NOT NULL,
  bill_number TEXT NOT NULL,
  title TEXT NOT NULL,
  topics_json TEXT NOT NULL,
  data_json TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  received_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS deliveries (
  subscriber_id INTEGER NOT NULL,
  event_id TEXT NOT NULL,
  delivered_at TEXT NOT NULL,
  PRIMARY KEY (subscriber_id, event_id),
  FOREIGN KEY (subscriber_id) REFERENCES subscribers(id),
  FOREIGN KEY (event_id) REFERENCES legislative_events(event_id)
);

CREATE INDEX IF NOT EXISTS idx_subscribers_delivery
  ON subscribers(active, confirmed, frequency);

CREATE INDEX IF NOT EXISTS idx_events_observed
  ON legislative_events(observed_at);

