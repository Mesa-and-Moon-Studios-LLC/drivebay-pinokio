<?php

/**
 * Licensing storage and rules. Uses its own SQLite file (license.sqlite) in a folder outside the web root,
 * next to the Ed25519 signing key and config.json. Nothing here touches the machine directory database.
 *
 * Folder layout (default ~/drivebay-data/license/, override with DRIVEBAY_LICENSE_DIR):
 *   signing.key   hex Ed25519 secret key (64 bytes). Mode 0600. Never in git, never served.
 *   config.json   admin token hash, payment provider secrets, product (SKU) map, mail switch.
 *   license.sqlite
 */

require_once __DIR__ . '/license_crypto.php';

class DrivebayLicenseError extends Exception {
    public $status;
    public $code_name;
    public $extra;
    public function __construct($codeName, $status, $message, $extra = []) {
        parent::__construct($message);
        $this->code_name = $codeName;
        $this->status = $status;
        $this->extra = $extra;
    }
}

const DRIVEBAY_RECEIPT_DAYS = 30;
const DRIVEBAY_SEAT_STALE_DAYS = 120;

function drivebay_license_dir() {
    $env = getenv('DRIVEBAY_LICENSE_DIR');
    if ($env) {
        return rtrim($env, '/\\');
    }
    return dirname(__DIR__, 3) . '/drivebay-data/license';
}

function drivebay_license_load_config($dir) {
    $file = $dir . '/config.json';
    if (!is_file($file)) {
        return [];
    }
    $parsed = json_decode((string) file_get_contents($file), true);
    return is_array($parsed) ? $parsed : [];
}

function drivebay_license_save_config($dir, $config) {
    $file = $dir . '/config.json';
    file_put_contents($file, json_encode($config, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES), LOCK_EX);
    @chmod($file, 0600);
}

function drivebay_license_open_db($dir) {
    if (!is_dir($dir) && !@mkdir($dir, 0700, true)) {
        throw new DrivebayLicenseError('server', 500, 'License storage is not available.');
    }
    $pdo = new PDO('sqlite:' . $dir . '/license.sqlite', null, null, [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
    ]);
    @chmod($dir . '/license.sqlite', 0600);
    $pdo->exec('PRAGMA busy_timeout = 5000');
    $pdo->exec('PRAGMA journal_mode = WAL');
    $pdo->exec('PRAGMA foreign_keys = ON');
    $pdo->exec(
        "CREATE TABLE IF NOT EXISTS licenses (
          id TEXT PRIMARY KEY,
          edition TEXT NOT NULL,
          seats INTEGER NOT NULL,
          offline INTEGER NOT NULL DEFAULT 0,
          issued INTEGER NOT NULL,
          expires INTEGER,
          updates_until INTEGER,
          label TEXT NOT NULL DEFAULT '',
          license_key TEXT NOT NULL,
          source TEXT NOT NULL DEFAULT 'admin',
          order_ref TEXT NOT NULL DEFAULT '',
          note TEXT NOT NULL DEFAULT '',
          created_at INTEGER NOT NULL,
          revoked_at INTEGER,
          revoked_reason TEXT NOT NULL DEFAULT ''
        );
        CREATE TABLE IF NOT EXISTS codes (
          code_hash TEXT PRIMARY KEY,
          kind TEXT NOT NULL DEFAULT 'purchase',
          edition TEXT NOT NULL,
          seats INTEGER NOT NULL,
          term_months INTEGER NOT NULL DEFAULT 0,
          updates_months INTEGER,
          label TEXT NOT NULL DEFAULT '',
          offline INTEGER NOT NULL DEFAULT 0,
          max_licenses INTEGER NOT NULL DEFAULT 1,
          code_expires INTEGER,
          note TEXT NOT NULL DEFAULT '',
          order_ref TEXT NOT NULL DEFAULT '',
          created_at INTEGER NOT NULL,
          disabled_at INTEGER
        );
        CREATE TABLE IF NOT EXISTS code_redemptions (
          code_hash TEXT NOT NULL,
          license_id TEXT NOT NULL,
          machine_hash TEXT NOT NULL,
          at INTEGER NOT NULL,
          PRIMARY KEY (code_hash, license_id)
        );
        CREATE TABLE IF NOT EXISTS activations (
          license_id TEXT NOT NULL,
          machine_id TEXT NOT NULL,
          name TEXT NOT NULL DEFAULT '',
          platform TEXT NOT NULL DEFAULT '',
          app_version TEXT NOT NULL DEFAULT '',
          activated_at INTEGER NOT NULL,
          last_seen INTEGER NOT NULL,
          PRIMARY KEY (license_id, machine_id)
        );
        CREATE TABLE IF NOT EXISTS webhook_events (
          provider TEXT NOT NULL,
          event_id TEXT NOT NULL,
          received_at INTEGER NOT NULL,
          outcome TEXT NOT NULL DEFAULT '',
          PRIMARY KEY (provider, event_id)
        );
        CREATE TABLE IF NOT EXISTS orders (
          provider TEXT NOT NULL,
          order_id TEXT NOT NULL,
          payment_ref TEXT NOT NULL DEFAULT '',
          email TEXT NOT NULL DEFAULT '',
          sku TEXT NOT NULL DEFAULT '',
          code_hashes TEXT NOT NULL DEFAULT '[]',
          status TEXT NOT NULL DEFAULT 'paid',
          created_at INTEGER NOT NULL,
          refunded_at INTEGER,
          PRIMARY KEY (provider, order_id)
        );
        CREATE TABLE IF NOT EXISTS outbox (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          to_email TEXT NOT NULL,
          subject TEXT NOT NULL,
          body TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          sent_at INTEGER,
          transport TEXT NOT NULL DEFAULT 'outbox'
        );
        CREATE TABLE IF NOT EXISTS attempts (
          bucket_key TEXT NOT NULL,
          hour INTEGER NOT NULL,
          n INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (bucket_key, hour)
        );"
    );
    return $pdo;
}

/**
 * @return array ctx: dir, pdo, secret (raw 64 bytes), public (raw 32), publicKeys (list), config, now
 */
function drivebay_license_ctx($dir = null, $now = null, $requireKey = true) {
    $dir = $dir ?: drivebay_license_dir();
    $ctx = ['dir' => $dir, 'now' => $now === null ? time() : (int) $now];
    $ctx['config'] = drivebay_license_load_config($dir);
    $keyFile = $dir . '/signing.key';
    $ctx['secret'] = null;
    $ctx['public'] = null;
    if (is_file($keyFile)) {
        $secret = hex2bin(trim((string) file_get_contents($keyFile)));
        if ($secret !== false && strlen($secret) === 64) {
            $ctx['secret'] = $secret;
            $ctx['public'] = sodium_crypto_sign_publickey_from_secretkey($secret);
        }
    } elseif ($requireKey && is_file($dir . '/public.key')) {
        // Verify-only host (no signing key).
        $pk = hex2bin(trim((string) file_get_contents($dir . '/public.key')));
        if ($pk !== false && strlen($pk) === 32) {
            $ctx['public'] = $pk;
        }
    }
    if ($requireKey && $ctx['public'] === null) {
        throw new DrivebayLicenseError('not_configured', 503, 'Licensing is not set up on this server yet.');
    }
    $ctx['publicKeys'] = $ctx['public'] === null ? [] : [$ctx['public']];
    $ctx['pdo'] = drivebay_license_open_db($dir);
    return $ctx;
}

function drivebay_license_add_months($ts, $months) {
    $d = new DateTimeImmutable('@' . $ts);
    return $d->setTimezone(new DateTimeZone('UTC'))->modify('+' . (int) $months . ' months')->getTimestamp();
}

/**
 * Create and store a license.
 * spec: edition, seats, termMonths (0 = perpetual), updatesMonths (null = default, -1 = lifetime),
 *       label, offline(bool), note
 */
function drivebay_license_create($ctx, $spec, $source = 'admin', $orderRef = '') {
    if ($ctx['secret'] === null) {
        throw new DrivebayLicenseError('no_signing_key', 503, 'This server cannot sign licenses.');
    }
    $now = $ctx['now'];
    $issued = $now;
    $term = isset($spec['termMonths']) ? (int) $spec['termMonths'] : 0;
    $expires = $term > 0 ? drivebay_license_add_months($issued, $term) : null;
    $um = array_key_exists('updatesMonths', $spec) ? $spec['updatesMonths'] : null;
    if ($um === null) {
        // Subscription: updates run to the end of the term. Perpetual: 12 months of updates by default.
        $updates = $expires !== null ? $expires : drivebay_license_add_months($issued, 12);
    } elseif ((int) $um < 0) {
        $updates = null;
    } else {
        $updates = drivebay_license_add_months($issued, (int) $um);
    }
    [$key, $license] = drivebay_license_mint([
        'edition' => $spec['edition'],
        'seats' => $spec['seats'],
        'issued' => $issued,
        'expires' => $expires,
        'updatesUntil' => $updates,
        'offline' => !empty($spec['offline']),
        'label' => isset($spec['label']) ? $spec['label'] : '',
    ], $ctx['secret']);
    $stmt = $ctx['pdo']->prepare(
        'INSERT INTO licenses (id, edition, seats, offline, issued, expires, updates_until, label, license_key, source, order_ref, note, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)'
    );
    $stmt->execute([
        $license['id'], $license['edition'], $license['seats'], $license['offline'] ? 1 : 0, $license['issued'],
        $license['expires'], $license['updatesUntil'], $license['label'], $key, $source, $orderRef,
        isset($spec['note']) ? (string) $spec['note'] : '', $now,
    ]);
    return [$key, $license];
}

/** Create a purchase or promo code. Returns the plaintext code (only time it is available). */
function drivebay_code_create($ctx, $spec, $orderRef = '') {
    $kind = isset($spec['kind']) && $spec['kind'] === 'promo' ? 'promo' : 'purchase';
    if (!in_array($spec['edition'], ['pro', 'elite', 'enterprise'], true)) {
        throw new DrivebayLicenseError('bad_request', 400, 'Unknown edition.');
    }
    $seats = (int) $spec['seats'];
    if ($seats < 1 || $seats > 65535) {
        throw new DrivebayLicenseError('bad_request', 400, 'Seats must be 1 to 65535.');
    }
    $max = $kind === 'purchase' ? 1 : max(1, (int) (isset($spec['maxLicenses']) ? $spec['maxLicenses'] : 1));
    $codeExpires = isset($spec['codeExpiresDays']) && (int) $spec['codeExpiresDays'] > 0 ? $ctx['now'] + (int) $spec['codeExpiresDays'] * 86400 : null;
    for ($try = 0; $try < 5; $try++) {
        $code = drivebay_code_generate();
        $hash = drivebay_code_hash(drivebay_code_normalise($code));
        try {
            $ctx['pdo']->prepare(
                'INSERT INTO codes (code_hash, kind, edition, seats, term_months, updates_months, label, offline, max_licenses, code_expires, note, order_ref, created_at)
                 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)'
            )->execute([
                $hash, $kind, $spec['edition'], $seats, isset($spec['termMonths']) ? (int) $spec['termMonths'] : 0,
                array_key_exists('updatesMonths', $spec) ? $spec['updatesMonths'] : null,
                isset($spec['label']) ? (string) $spec['label'] : '', !empty($spec['offline']) ? 1 : 0, $max, $codeExpires,
                isset($spec['note']) ? (string) $spec['note'] : '', $orderRef, $ctx['now'],
            ]);
            return [$code, $hash];
        } catch (PDOException $err) {
            if ($try === 4) {
                throw $err;
            }
        }
    }
    return null;
}

function drivebay_license_throttle($ctx, $bucketKey, $limit = 30, $record = false) {
    $hour = (int) floor($ctx['now'] / 3600);
    $pdo = $ctx['pdo'];
    if ($record) {
        $pdo->prepare('INSERT INTO attempts (bucket_key, hour, n) VALUES (?,?,1) ON CONFLICT(bucket_key, hour) DO UPDATE SET n = n + 1')->execute([$bucketKey, $hour]);
        return;
    }
    $stmt = $pdo->prepare('SELECT n FROM attempts WHERE bucket_key = ? AND hour = ?');
    $stmt->execute([$bucketKey, $hour]);
    $n = (int) $stmt->fetchColumn();
    if ($n >= $limit) {
        throw new DrivebayLicenseError('rate_limited', 429, 'Too many wrong codes from this address. Try again in an hour.');
    }
    $pdo->prepare('DELETE FROM attempts WHERE hour < ?')->execute([$hour - 48]);
}

function drivebay_license_row_to_license($row) {
    return [
        'id' => $row['id'],
        'edition' => $row['edition'],
        'seats' => (int) $row['seats'],
        'offline' => (int) $row['offline'] === 1,
        'issued' => (int) $row['issued'],
        'expires' => $row['expires'] === null ? null : (int) $row['expires'],
        'updatesUntil' => $row['updates_until'] === null ? null : (int) $row['updates_until'],
        'label' => $row['label'],
    ];
}

function drivebay_license_seats_used($ctx, $licenseId) {
    $stmt = $ctx['pdo']->prepare('SELECT COUNT(*) FROM activations WHERE license_id = ? AND last_seen >= ?');
    $stmt->execute([$licenseId, $ctx['now'] - DRIVEBAY_SEAT_STALE_DAYS * 86400]);
    return (int) $stmt->fetchColumn();
}

function drivebay_license_summary($ctx, $row) {
    $license = drivebay_license_row_to_license($row);
    $license['seatsUsed'] = drivebay_license_seats_used($ctx, $row['id']);
    $license['revoked'] = $row['revoked_at'] !== null;
    return $license;
}

/** Resolve a typed code or key to a licenses row, creating one from a purchase/promo code when needed. */
function drivebay_license_resolve($ctx, $keyText, $machineId, $ip, $create = true) {
    $text = trim((string) $keyText);
    $pdo = $ctx['pdo'];
    $throttleKey = 'ip:' . hash('sha256', (string) $ip);
    drivebay_license_throttle($ctx, $throttleKey);
    $normalised = drivebay_code_normalise($text);
    if ($normalised !== null) {
        $hash = drivebay_code_hash($normalised);
        $stmt = $pdo->prepare('SELECT * FROM codes WHERE code_hash = ?');
        $stmt->execute([$hash]);
        $code = $stmt->fetch();
        if (!$code) {
            drivebay_license_throttle($ctx, $throttleKey, 30, true);
            throw new DrivebayLicenseError('unknown_code', 404, 'That code was not found. Check it for typos.');
        }
        if ($code['disabled_at'] !== null) {
            throw new DrivebayLicenseError('code_disabled', 410, 'That code is no longer valid.');
        }
        $machineHash = bin2hex(drivebay_machine_hash($machineId));
        // Already redeemed: same buyer adding another device (purchase), or the same device again (promo).
        $stmt = $pdo->prepare('SELECT r.license_id, r.machine_hash FROM code_redemptions r WHERE r.code_hash = ? ORDER BY r.at');
        $stmt->execute([$hash]);
        $redemptions = $stmt->fetchAll();
        $found = null;
        foreach ($redemptions as $r) {
            if ($code['kind'] === 'purchase' || $r['machine_hash'] === $machineHash) {
                $found = $r['license_id'];
                break;
            }
        }
        if ($found === null && !$create) {
            return ['unredeemed' => true, 'code' => $code];
        }
        if ($found === null) {
            if ($code['code_expires'] !== null && $ctx['now'] >= (int) $code['code_expires']) {
                throw new DrivebayLicenseError('code_expired', 410, 'That code has expired.');
            }
            if (count($redemptions) >= (int) $code['max_licenses']) {
                throw new DrivebayLicenseError('code_used', 409, 'That code has already been used.');
            }
            $pdo->beginTransaction();
            try {
                [$key, $license] = drivebay_license_create($ctx, [
                    'edition' => $code['edition'], 'seats' => $code['seats'], 'termMonths' => $code['term_months'],
                    'updatesMonths' => $code['updates_months'] === null ? null : (int) $code['updates_months'],
                    'label' => $code['label'], 'offline' => (int) $code['offline'] === 1,
                ], $code['kind'], $code['order_ref']);
                $pdo->prepare('INSERT INTO code_redemptions (code_hash, license_id, machine_hash, at) VALUES (?,?,?,?)')
                    ->execute([$hash, $license['id'], $machineHash, $ctx['now']]);
                $pdo->commit();
            } catch (Throwable $err) {
                $pdo->rollBack();
                throw $err;
            }
            $found = $license['id'];
        }
        $stmt = $pdo->prepare('SELECT * FROM licenses WHERE id = ?');
        $stmt->execute([$found]);
        return $stmt->fetch();
    }
    $check = drivebay_license_verify($text, $ctx['publicKeys']);
    if (!$check['ok']) {
        drivebay_license_throttle($ctx, $throttleKey, 30, true);
        throw new DrivebayLicenseError(
            $check['error'] === 'signature' ? 'bad_signature' : 'bad_format',
            400,
            $check['error'] === 'signature' ? 'That license key did not verify. Check it for typos.' : 'That does not look like a Drivebay code or license key.'
        );
    }
    $stmt = $pdo->prepare('SELECT * FROM licenses WHERE id = ?');
    $stmt->execute([$check['license']['id']]);
    $row = $stmt->fetch();
    if (!$row) {
        throw new DrivebayLicenseError('unknown_license', 404, 'This license is valid but is not registered on this server.');
    }
    return $row;
}

function drivebay_license_activate($ctx, $keyText, $machine, $ip = '') {
    $machineId = isset($machine['id']) ? (string) $machine['id'] : '';
    if (!preg_match('/^[A-Za-z0-9_.:-]{8,64}$/', $machineId)) {
        throw new DrivebayLicenseError('bad_request', 400, 'Machine id is missing or invalid.');
    }
    $row = drivebay_license_resolve($ctx, $keyText, $machineId, $ip);
    if ($row['revoked_at'] !== null) {
        throw new DrivebayLicenseError('revoked', 403, 'This license was revoked.' . ($row['revoked_reason'] !== '' ? ' ' . $row['revoked_reason'] : ''));
    }
    $license = drivebay_license_row_to_license($row);
    if (drivebay_license_state($license, $ctx['now']) === 'expired') {
        throw new DrivebayLicenseError('expired', 410, 'This license has expired.', ['license' => $license]);
    }
    $pdo = $ctx['pdo'];
    $stmt = $pdo->prepare('SELECT * FROM activations WHERE license_id = ? AND machine_id = ?');
    $stmt->execute([$row['id'], $machineId]);
    $existing = $stmt->fetch();
    if (!$existing) {
        $stmt = $pdo->prepare('SELECT machine_id, name, platform, last_seen FROM activations WHERE license_id = ? AND last_seen >= ? ORDER BY last_seen DESC');
        $stmt->execute([$row['id'], $ctx['now'] - DRIVEBAY_SEAT_STALE_DAYS * 86400]);
        $active = $stmt->fetchAll();
        if (count($active) >= (int) $row['seats']) {
            $devices = array_map(function ($d) {
                return ['name' => $d['name'], 'platform' => $d['platform'], 'lastSeen' => (int) $d['last_seen'], 'ref' => substr(hash('sha256', $d['machine_id']), 0, 8)];
            }, $active);
            throw new DrivebayLicenseError('seats_full', 409, 'All ' . (int) $row['seats'] . ' seats on this license are in use. Deactivate one of those devices first.', ['seats' => (int) $row['seats'], 'devices' => $devices]);
        }
        $pdo->prepare('INSERT INTO activations (license_id, machine_id, name, platform, app_version, activated_at, last_seen) VALUES (?,?,?,?,?,?,?)')
            ->execute([$row['id'], $machineId, substr((string) ($machine['name'] ?? ''), 0, 80), substr((string) ($machine['platform'] ?? ''), 0, 24), substr((string) ($machine['appVersion'] ?? ''), 0, 24), $ctx['now'], $ctx['now']]);
    } else {
        $pdo->prepare('UPDATE activations SET last_seen = ?, name = ?, platform = ?, app_version = ? WHERE license_id = ? AND machine_id = ?')
            ->execute([$ctx['now'], substr((string) ($machine['name'] ?? $existing['name']), 0, 80), substr((string) ($machine['platform'] ?? $existing['platform']), 0, 24), substr((string) ($machine['appVersion'] ?? $existing['app_version']), 0, 24), $row['id'], $machineId]);
    }
    $validUntil = $ctx['now'] + DRIVEBAY_RECEIPT_DAYS * 86400;
    if ($license['expires'] !== null) {
        $validUntil = min($validUntil, $license['expires'] + 86400);
    }
    $receipt = drivebay_receipt_mint($row['id'], $machineId, $ctx['now'], $validUntil, $ctx['secret']);
    return [
        'licenseKey' => $row['license_key'],
        'receipt' => $receipt,
        'receiptValidUntil' => $validUntil,
        'license' => drivebay_license_summary($ctx, $row),
    ];
}

function drivebay_license_deactivate($ctx, $keyText, $machineId, $ip = '') {
    $row = drivebay_license_resolve($ctx, $keyText, (string) $machineId, $ip);
    $stmt = $ctx['pdo']->prepare('DELETE FROM activations WHERE license_id = ? AND machine_id = ?');
    $stmt->execute([$row['id'], (string) $machineId]);
    return ['ok' => true, 'released' => $stmt->rowCount() > 0, 'license' => drivebay_license_summary($ctx, $row)];
}

function drivebay_license_status($ctx, $keyText, $ip = '') {
    $row = drivebay_license_resolve($ctx, $keyText, 'status-only-000', $ip, false);
    if (isset($row['unredeemed'])) {
        $c = $row['code'];
        return ['unredeemed' => true, 'edition' => $c['edition'], 'seats' => (int) $c['seats'], 'termMonths' => (int) $c['term_months'], 'kind' => $c['kind']];
    }
    return drivebay_license_summary($ctx, $row);
}

function drivebay_license_revoke($ctx, $licenseId, $reason = '') {
    $stmt = $ctx['pdo']->prepare('UPDATE licenses SET revoked_at = ?, revoked_reason = ? WHERE id = ? AND revoked_at IS NULL');
    $stmt->execute([$ctx['now'], substr($reason, 0, 200), $licenseId]);
    return $stmt->rowCount() > 0;
}

function drivebay_license_unrevoke($ctx, $licenseId) {
    $stmt = $ctx['pdo']->prepare("UPDATE licenses SET revoked_at = NULL, revoked_reason = '' WHERE id = ?");
    $stmt->execute([$licenseId]);
    return $stmt->rowCount() > 0;
}

function drivebay_license_release_seat($ctx, $licenseId, $machineRef) {
    // machineRef: full machine id or the 8-char ref from the seats_full list.
    $stmt = $ctx['pdo']->prepare('SELECT machine_id FROM activations WHERE license_id = ?');
    $stmt->execute([$licenseId]);
    $n = 0;
    foreach ($stmt->fetchAll() as $r) {
        if ($r['machine_id'] === $machineRef || substr(hash('sha256', $r['machine_id']), 0, 8) === $machineRef) {
            $ctx['pdo']->prepare('DELETE FROM activations WHERE license_id = ? AND machine_id = ?')->execute([$licenseId, $r['machine_id']]);
            $n++;
        }
    }
    return $n;
}
