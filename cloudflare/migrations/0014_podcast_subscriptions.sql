CREATE TABLE podcast_catalog (
  id TEXT PRIMARY KEY,
  show_json TEXT NOT NULL,
  episodes_json TEXT NOT NULL DEFAULT '[]',
  checked_at INTEGER NOT NULL DEFAULT 0,
  attempted_at INTEGER NOT NULL DEFAULT 0,
  refresh_error INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE podcast_subscriptions (
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  show_id TEXT NOT NULL REFERENCES podcast_catalog(id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY(owner_id, show_id)
);
CREATE INDEX podcast_subscriptions_show ON podcast_subscriptions(show_id);
CREATE TABLE podcast_search_cache (
  query TEXT NOT NULL,
  country TEXT NOT NULL,
  results_json TEXT NOT NULL,
  checked_at INTEGER NOT NULL,
  PRIMARY KEY(query, country)
);
