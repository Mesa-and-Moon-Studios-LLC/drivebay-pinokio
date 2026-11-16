<?php
/**
 * Drivebay 3.38.0 schema migration. Staged only.
 * Run from the command line after uploading, once Aaron OKs a deploy:
 *   php migrate-33800.php
 * It is safe to run more than once. It does not encrypt existing rows;
 * that happens on the user's device when they lock the list.
 *
 * Do not print configuration, tokens, or row contents.
 */

if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    header('Content-Type: text/plain; charset=utf-8');
    echo "Not found.\n";
    exit;
}

require __DIR__ . '/lib/bootstrap.php';

$pdo = drivebay_pdo();
$driver = $pdo->getAttribute(PDO::ATTR_DRIVER_NAME);
$log = function ($msg) {
    fwrite(STDOUT, $msg . PHP_EOL);
};

if ($driver === 'sqlite') {
    $cols = [];
    foreach ($pdo->query('PRAGMA table_info(drivebay_machines)')->fetchAll() as $row) {
        $cols[$row['name']] = true;
    }
    if (empty($cols['envelope_version'])) {
        $pdo->exec('ALTER TABLE drivebay_machines ADD COLUMN envelope_version INTEGER NOT NULL DEFAULT 1');
        $log('Added envelope_version');
    }
    if (empty($cols['ciphertext'])) {
        $pdo->exec("ALTER TABLE drivebay_machines ADD COLUMN ciphertext TEXT NOT NULL DEFAULT ''");
        $log('Added ciphertext');
    }
    if (empty($cols['nonce'])) {
        $pdo->exec("ALTER TABLE drivebay_machines ADD COLUMN nonce TEXT NOT NULL DEFAULT ''");
        $log('Added nonce');
    }
} else {
    $cols = [];
    $stmt = $pdo->query('SHOW COLUMNS FROM drivebay_machines');
    foreach ($stmt->fetchAll() as $row) {
        $cols[$row['Field']] = true;
    }
    if (empty($cols['envelope_version'])) {
        $pdo->exec('ALTER TABLE drivebay_machines ADD COLUMN envelope_version TINYINT NOT NULL DEFAULT 1');
        $log('Added envelope_version');
    }
    if (empty($cols['ciphertext'])) {
        $pdo->exec("ALTER TABLE drivebay_machines ADD COLUMN ciphertext MEDIUMTEXT NOT NULL");
        $log('Added ciphertext');
    }
    if (empty($cols['nonce'])) {
        $pdo->exec("ALTER TABLE drivebay_machines ADD COLUMN nonce VARCHAR(64) NOT NULL DEFAULT ''");
        $log('Added nonce');
    }
}

$pdo->exec(
    "CREATE TABLE IF NOT EXISTS drivebay_key_wraps (
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
    )"
);
$log('drivebay_key_wraps is ready');
$log('Migration 33800 complete. Existing plaintext rows were left as-is.');
