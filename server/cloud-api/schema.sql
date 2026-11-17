-- Drivebay cloud. Connection info only, or an encrypted directory envelope.
-- Do not add columns for share paths, secrets, codes, or a raw DEK.

CREATE TABLE IF NOT EXISTS drivebay_machines (
  uid VARCHAR(128) NOT NULL,
  machine_id VARCHAR(64) NOT NULL,
  display_name VARCHAR(80) NOT NULL DEFAULT '',
  machine_type VARCHAR(16) NOT NULL DEFAULT 'pc',
  tailscale_host VARCHAR(255) NOT NULL DEFAULT '',
  lan_address VARCHAR(255) NOT NULL DEFAULT '',
  port INT NOT NULL DEFAULT 0,
  public_key VARCHAR(4096) NOT NULL DEFAULT '',
  last_seen DATETIME NOT NULL,
  hidden TINYINT(1) NOT NULL DEFAULT 0,
  direct_internet TINYINT(1) NOT NULL DEFAULT 0,
  public_host VARCHAR(255) NOT NULL DEFAULT '',
  envelope_version TINYINT NOT NULL DEFAULT 1,
  ciphertext MEDIUMTEXT NOT NULL,
  nonce VARCHAR(64) NOT NULL DEFAULT '',
  PRIMARY KEY (uid, machine_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Wrapped copies of the account DEK. The DEK itself is never stored.
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

-- SQLite (default on the live host) creates these tables automatically
-- on first request or when migrate-33800.php is run. See lib/bootstrap.php.
