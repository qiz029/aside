ALTER TABLE users ADD COLUMN deleted_at INTEGER;
ALTER TABLE auth_identities ADD COLUMN refresh_token TEXT;
ALTER TABLE auth_identities ADD COLUMN client_id TEXT;
CREATE TABLE apple_challenges (
  nonce TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  user_id TEXT,
  expires INTEGER NOT NULL
);
CREATE TABLE account_consents (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  version TEXT NOT NULL,
  accepted_at INTEGER NOT NULL
);
