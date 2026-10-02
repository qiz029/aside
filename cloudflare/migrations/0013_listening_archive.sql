-- Personal history is separate from the replaceable playback checkpoint.
CREATE TABLE listening_events (
  ordinal INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER NOT NULL,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  payload TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  UNIQUE(owner_id, id),
  CHECK(ended_at > started_at AND end_ms > start_ms)
);
CREATE INDEX listening_events_episode ON listening_events(owner_id, episode_id, ordinal);
CREATE INDEX listening_events_recent ON listening_events(owner_id, ended_at, episode_id);
CREATE INDEX listening_events_cleanup ON listening_events(episode_id);

CREATE TABLE conversations (
  ordinal INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  at_ms INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(owner_id, id)
);
CREATE INDEX conversations_episode ON conversations(owner_id, episode_id, ordinal);
CREATE INDEX conversations_cleanup ON conversations(episode_id);

CREATE TABLE conversation_turns (
  ordinal INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  at_ms INTEGER NOT NULL,
  payload TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  FOREIGN KEY(owner_id, conversation_id) REFERENCES conversations(owner_id, id) ON DELETE CASCADE,
  UNIQUE(owner_id, conversation_id, id),
  UNIQUE(owner_id, conversation_id, sequence)
);
CREATE INDEX conversation_turns_context ON conversation_turns(owner_id, at_ms, ordinal);
