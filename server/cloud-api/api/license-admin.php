<?php
/**
 * Drivebay licensing admin API. POST JSON {action, ...} with header X-Drivebay-Admin: <token>.
 * The token is random and only its SHA-256 is stored (config.json, outside the web root).
 * Actions: mint, code, list, revoke, unrevoke, seats, release, outbox, outbox-purge.
 */
require dirname(__DIR__) . '/lib/bootstrap.php';
require dirname(__DIR__) . '/lib/license_orders.php';

if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'POST') {
    drivebay_fail(405, 'Method not allowed.');
}
$https = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') || (($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https') || getenv('DRIVEBAY_ALLOW_HTTP_ADMIN') === '1';
if (!$https) {
    drivebay_fail(400, 'Use HTTPS.');
}
try {
    $ctx = drivebay_license_ctx();
    $ip = isset($_SERVER['REMOTE_ADDR']) ? $_SERVER['REMOTE_ADDR'] : '';
    $bucket = 'admin:' . hash('sha256', $ip);
    drivebay_license_throttle($ctx, $bucket, 10);
    $expected = isset($ctx['config']['admin_token_sha256']) ? (string) $ctx['config']['admin_token_sha256'] : '';
    $given = isset($_SERVER['HTTP_X_DRIVEBAY_ADMIN']) ? (string) $_SERVER['HTTP_X_DRIVEBAY_ADMIN'] : '';
    if ($expected === '' || $given === '' || !hash_equals($expected, hash('sha256', $given))) {
        drivebay_license_throttle($ctx, $bucket, 10, true);
        drivebay_fail(401, 'Admin token required.');
    }
    $in = drivebay_body();
    $action = isset($in['action']) ? (string) $in['action'] : '';
    $pdo = $ctx['pdo'];
    $spec = function ($in) {
        return [
            'edition' => (string) ($in['edition'] ?? ''),
            'seats' => (int) ($in['seats'] ?? 1),
            'termMonths' => (int) ($in['termMonths'] ?? 0),
            'updatesMonths' => array_key_exists('updatesMonths', $in) && $in['updatesMonths'] !== null ? (int) $in['updatesMonths'] : null,
            'label' => (string) ($in['label'] ?? ''),
            'offline' => !empty($in['offline']),
            'note' => (string) ($in['note'] ?? ''),
            'kind' => (string) ($in['kind'] ?? 'purchase'),
            'maxLicenses' => (int) ($in['maxLicenses'] ?? 1),
            'codeExpiresDays' => (int) ($in['codeExpiresDays'] ?? 0),
        ];
    };
    if ($action === 'mint') {
        [$key, $license] = drivebay_license_create($ctx, $spec($in), 'admin');
        drivebay_json(['ok' => true, 'licenseKey' => $key, 'license' => $license]);
    }
    if ($action === 'code') {
        $count = min(200, max(1, (int) ($in['count'] ?? 1)));
        $codes = [];
        for ($i = 0; $i < $count; $i++) {
            [$code] = drivebay_code_create($ctx, $spec($in), 'admin');
            $codes[] = $code;
        }
        drivebay_json(['ok' => true, 'codes' => $codes]);
    }
    if ($action === 'list') {
        $what = (string) ($in['what'] ?? 'licenses');
        $tables = ['licenses' => 'licenses ORDER BY created_at DESC', 'codes' => 'codes ORDER BY created_at DESC', 'orders' => 'orders ORDER BY created_at DESC', 'activations' => 'activations ORDER BY last_seen DESC'];
        if (!isset($tables[$what])) {
            drivebay_fail(400, 'Unknown list.');
        }
        $rows = $pdo->query('SELECT * FROM ' . $tables[$what] . ' LIMIT 500')->fetchAll();
        if ($what === 'activations') {
            foreach ($rows as &$r) {
                $r['machine_id'] = substr($r['machine_id'], 0, 8) . '…';
            }
        }
        drivebay_json(['ok' => true, 'rows' => $rows]);
    }
    if ($action === 'revoke') {
        drivebay_json(['ok' => true, 'revoked' => drivebay_license_revoke($ctx, (string) ($in['id'] ?? ''), (string) ($in['reason'] ?? ''))]);
    }
    if ($action === 'unrevoke') {
        drivebay_json(['ok' => true, 'restored' => drivebay_license_unrevoke($ctx, (string) ($in['id'] ?? ''))]);
    }
    if ($action === 'seats') {
        $stmt = $pdo->prepare('SELECT name, platform, app_version, activated_at, last_seen, substr(machine_id, 1, 8) AS ref FROM activations WHERE license_id = ?');
        $stmt->execute([(string) ($in['id'] ?? '')]);
        drivebay_json(['ok' => true, 'rows' => $stmt->fetchAll()]);
    }
    if ($action === 'release') {
        drivebay_json(['ok' => true, 'released' => drivebay_license_release_seat($ctx, (string) ($in['id'] ?? ''), (string) ($in['machine'] ?? ''))]);
    }
    if ($action === 'outbox') {
        drivebay_json(['ok' => true, 'rows' => $pdo->query('SELECT * FROM outbox ORDER BY id DESC LIMIT 100')->fetchAll()]);
    }
    if ($action === 'outbox-purge') {
        $n = $pdo->exec('DELETE FROM outbox');
        drivebay_json(['ok' => true, 'deleted' => $n]);
    }
    drivebay_fail(400, 'Unknown action.');
} catch (DrivebayLicenseError $err) {
    drivebay_json(['error' => $err->getMessage(), 'code' => $err->code_name] + $err->extra, $err->status);
} catch (InvalidArgumentException $err) {
    drivebay_fail(400, $err->getMessage());
} catch (Throwable $err) {
    error_log('drivebay license admin: ' . $err->getMessage());
    drivebay_fail(500, 'Admin action failed.');
}
