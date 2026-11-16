<?php

/**
 * Never write Authorization headers, bearer tokens, or wrap secrets to logs.
 */
function drivebay_redact_log($message) {
    $text = (string) $message;
    $text = preg_replace('/(Authorization:\s*Bearer\s+)\S+/i', '$1[redacted]', $text);
    $text = preg_replace('/(?i)(bearer\s+)[A-Za-z0-9._\-+=\/]+/', '$1[redacted]', $text);
    $text = preg_replace('/(?i)(id_token|refresh_token|access_token|idToken|refreshToken|wrappedDek|privateKey)(["\']?\s*[:=]\s*)([^&\s"\']+)/', '$1$2[redacted]', $text);
    return $text;
}

function drivebay_log($message) {
    error_log(drivebay_redact_log($message));
}

function drivebay_config() {
    static $config = null;
    if ($config !== null) {
        return $config;
    }
    $path = dirname(__DIR__) . '/config.php';
    if (!is_file($path)) {
        drivebay_fail(500, 'Cloud API is not configured.');
    }
    $loaded = require $path;
    if (!is_array($loaded) || empty($loaded['firebase_project_id'])) {
        drivebay_fail(500, 'Cloud API config is incomplete.');
    }
    $config = $loaded;
    return $config;
}

function drivebay_fail($status, $message) {
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    echo json_encode(['error' => $message]);
    exit;
}

function drivebay_json($value, $status = 200) {
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    echo json_encode($value);
    exit;
}

function drivebay_sqlite_path($config) {
    if (!empty($config['sqlite_path'])) {
        return $config['sqlite_path'];
    }
    $home = dirname(__DIR__, 3);
    $outside = $home . '/drivebay-data';
    if ((is_dir($outside) || @mkdir($outside, 0700, true)) && is_writable($outside)) {
        return $outside . '/drivebay.sqlite';
    }
    $inside = dirname(__DIR__) . '/data';
    if (!is_dir($inside)) {
        @mkdir($inside, 0700, true);
    }
    $ht = $inside . '/.htaccess';
    if (!is_file($ht)) {
        @file_put_contents($ht, "Require all denied\n<IfModule !mod_authz_core.c>\n  Order deny,allow\n  Deny from all\n</IfModule>\n");
    }
    return $inside . '/drivebay.sqlite';
}

function drivebay_init_schema(PDO $pdo) {
    $driver = $pdo->getAttribute(PDO::ATTR_DRIVER_NAME);
    if ($driver === 'sqlite') {
        $pdo->exec('PRAGMA busy_timeout = 5000');
        $pdo->exec('PRAGMA journal_mode = WAL');
        $pdo->exec(
            "CREATE TABLE IF NOT EXISTS drivebay_machines (
              uid TEXT NOT NULL,
              machine_id TEXT NOT NULL,
              display_name TEXT NOT NULL DEFAULT '',
              machine_type TEXT NOT NULL DEFAULT 'pc',
              tailscale_host TEXT NOT NULL DEFAULT '',
              lan_address TEXT NOT NULL DEFAULT '',
              port INTEGER NOT NULL DEFAULT 0,
              public_key TEXT NOT NULL DEFAULT '',
              last_seen TEXT NOT NULL,
              hidden INTEGER NOT NULL DEFAULT 0,
              direct_internet INTEGER NOT NULL DEFAULT 0,
              public_host TEXT NOT NULL DEFAULT '',
              envelope_version INTEGER NOT NULL DEFAULT 1,
              ciphertext TEXT NOT NULL DEFAULT '',
              nonce TEXT NOT NULL DEFAULT '',
              PRIMARY KEY (uid, machine_id)
            )"
        );
        $pdo->exec(
            "CREATE TABLE IF NOT EXISTS drivebay_key_wraps (
              uid TEXT NOT NULL,
              wrap_id TEXT NOT NULL,
              kind TEXT NOT NULL,
              alg TEXT NOT NULL,
              wrapped_dek TEXT NOT NULL,
              nonce TEXT NOT NULL,
              salt TEXT NOT NULL DEFAULT '',
              params TEXT NOT NULL,
              credential_id TEXT NOT NULL DEFAULT '',
              created_at TEXT NOT NULL,
              PRIMARY KEY (uid, wrap_id)
            )"
        );
        $cols = [];
        foreach ($pdo->query('PRAGMA table_info(drivebay_machines)')->fetchAll() as $row) {
            $cols[$row['name']] = true;
        }
        if (empty($cols['envelope_version'])) {
            $pdo->exec('ALTER TABLE drivebay_machines ADD COLUMN envelope_version INTEGER NOT NULL DEFAULT 1');
        }
        if (empty($cols['ciphertext'])) {
            $pdo->exec("ALTER TABLE drivebay_machines ADD COLUMN ciphertext TEXT NOT NULL DEFAULT ''");
        }
        if (empty($cols['nonce'])) {
            $pdo->exec("ALTER TABLE drivebay_machines ADD COLUMN nonce TEXT NOT NULL DEFAULT ''");
        }
        return;
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
}

function drivebay_pdo() {
    static $pdo = null;
    if ($pdo !== null) {
        return $pdo;
    }
    $config = drivebay_config();
    $options = [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
    ];
    if (!empty($config['db_dsn'])) {
        $options[PDO::ATTR_EMULATE_PREPARES] = false;
        $pdo = new PDO($config['db_dsn'], $config['db_user'] ?? null, $config['db_pass'] ?? null, $options);
        drivebay_init_schema($pdo);
        return $pdo;
    }
    if (!empty($config['db_name'])) {
        $options[PDO::ATTR_EMULATE_PREPARES] = false;
        $dsn = 'mysql:host=' . ($config['db_host'] ?? 'localhost') . ';dbname=' . $config['db_name'] . ';charset=utf8mb4';
        $pdo = new PDO($dsn, $config['db_user'] ?? '', $config['db_pass'] ?? '', $options);
        drivebay_init_schema($pdo);
        return $pdo;
    }
    $path = drivebay_sqlite_path($config);
    $pdo = new PDO('sqlite:' . $path, null, null, $options);
    @chmod($path, 0600);
    drivebay_init_schema($pdo);
    return $pdo;
}

function drivebay_bearer() {
    $header = isset($_SERVER['HTTP_AUTHORIZATION']) ? $_SERVER['HTTP_AUTHORIZATION'] : '';
    if (!preg_match('/^Bearer\s+(\S+)$/i', $header, $match)) {
        drivebay_fail(401, 'Sign in required.');
    }
    require_once __DIR__ . '/firebase_token.php';
    $user = drivebay_verify_firebase_jwt($match[1], drivebay_config()['firebase_project_id']);
    if ($user === null) {
        drivebay_fail(401, 'Sign in required.');
    }
    return $user;
}

function drivebay_body() {
    $raw = file_get_contents('php://input');
    if ($raw === false || $raw === '') {
        return [];
    }
    $parsed = json_decode($raw, true);
    if (!is_array($parsed)) {
        drivebay_fail(400, 'Expected JSON.');
    }
    return $parsed;
}
