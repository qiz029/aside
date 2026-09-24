ALTER TABLE auth_oauth_states ADD COLUMN mobile_challenge TEXT;
ALTER TABLE auth_oauth_states ADD COLUMN mobile_scheme TEXT;
CREATE TABLE auth_mobile_grants (
  code_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  challenge TEXT NOT NULL,
  expires INTEGER NOT NULL
);
