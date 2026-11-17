-- Drivebay 3.38.0. Staged only. Do not run on the live host until Aaron OKs it.
-- Adds encrypted-directory columns and the wrap table.
-- Existing plaintext rows stay readable until each user locks their list;
-- the client then uploads ciphertext and the API clears the plaintext fields.

ALTER TABLE drivebay_machines
  ADD COLUMN envelope_version TINYINT NOT NULL DEFAULT 1;

ALTER TABLE drivebay_machines
  ADD COLUMN ciphertext MEDIUMTEXT NOT NULL DEFAULT '';

ALTER TABLE drivebay_machines
  ADD COLUMN nonce VARCHAR(64) NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS drivebay_key_wraps (
  uid VARCHAR(128) NOT NULL,
  wrap_id VARCHAR(64) NOT NULL,
  kind VARCHAR(16) NOT NULL,
  alg VARCHAR(64) NOT NULL,
  wrapped_dek TEXT NOT NULL,
  nonce VARCHAR(64) NOT NULL,
  salt VARCHAR(128) NOT NULL DEFAULT '',
  params TEXT NOT NULL,
  credential_id VARCHAR(512) NOT NULL DEFAULT '',
  created_at DATETIME NOT NULL,
  PRIMARY KEY (uid, wrap_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
