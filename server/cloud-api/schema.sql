-- Drivebay cloud. Connection info only.
-- Do not add columns for share paths, secrets, or codes.

CREATE TABLE IF NOT EXISTS drivebay_machines (
  uid VARCHAR(128) NOT NULL,
  machine_id VARCHAR(64) NOT NULL,
  display_name VARCHAR(80) NOT NULL,
  machine_type ENUM('pc', 'mac', 'linux', 'phone') NOT NULL,
  tailscale_host VARCHAR(255) NOT NULL DEFAULT '',
  lan_address VARCHAR(255) NOT NULL DEFAULT '',
  port INT NOT NULL,
  public_key VARCHAR(4096) NOT NULL,
  last_seen DATETIME NOT NULL,
  hidden TINYINT(1) NOT NULL DEFAULT 0,
  direct_internet TINYINT(1) NOT NULL DEFAULT 0,
  public_host VARCHAR(255) NOT NULL DEFAULT '',
  PRIMARY KEY (uid, machine_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
