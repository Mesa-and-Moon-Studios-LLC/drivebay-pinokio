<?php

/**
 * Enterprise self-host license gate. Loaded by enterprise/license-gate.php (php.ini auto_prepend_file).
 *
 * What it enforces, offline, with the public key and the customer's .dbaylicense file:
 *  - the file is genuine (Ed25519 signature) and is an Enterprise license
 *  - the term has not ended (expiry), and this server build was released inside the updates window
 *  - the number of registered machines stays within the licensed seat count
 *
 * What it never does: lock people out of data they already have. When the license is missing, expired or full,
 * existing machines keep working and reading. Only registering a NEW machine is refused (HTTP 402).
 * It does not phone home. Nothing leaves the customer's network.
 */
require_once __DIR__ . '/license_crypto.php';

function drivebay_gate_public_keys($override = null) {
    if (is_array($override)) {
        return $override;
    }
    // Production public key. The matching private key never leaves Mesa and Moon.
    return [hex2bin('c9258c6b8c94fd949294d39bcd31cbc40b4a11219d762183c340465d83c35010')];
}

function drivebay_gate_read_key($file) {
    if (!is_file($file) || !is_readable($file)) {
        return '';
    }
    $text = (string) file_get_contents($file);
    if (preg_match('/^\s*Key:\s*(DBAY[A-Za-z0-9\s-]+?)\s*(?:-----END|$)/mi', $text, $m)) {
        return preg_replace('/\s+/', '', $m[1]);
    }
    if (preg_match('/DBAY-[A-Za-z0-9-]{40,}/', $text, $m)) {
        return $m[0];
    }
    return '';
}

/**
 * @return array state: ok | missing | invalid | not_enterprise | expired | updates_ended ; license: array|null
 */
function drivebay_gate_evaluate($file, $publicKeys, $now, $buildTs = null) {
    $key = drivebay_gate_read_key($file);
    if ($key === '') {
        return ['state' => 'missing', 'license' => null, 'message' => 'No Enterprise license file was found.'];
    }
    $v = drivebay_license_verify($key, $publicKeys);
    if (!$v['ok']) {
        return ['state' => 'invalid', 'license' => null, 'message' => 'The license file did not verify. Ask Mesa and Moon for a new one.'];
    }
    $license = $v['license'];
    if ($license['edition'] !== 'enterprise') {
        return ['state' => 'not_enterprise', 'license' => $license, 'message' => 'Self-hosting needs an Enterprise license.'];
    }
    $state = drivebay_license_state($license, $now, $buildTs);
    $messages = [
        'active' => 'Licensed.',
        'expired' => 'The license term has ended. Existing machines keep working. Renew to add machines.',
        'updates_ended' => 'The updates included with this license ended before this server version was released. Renew updates, or run an earlier version.',
    ];
    return ['state' => $state === 'active' ? 'ok' : $state, 'license' => $license, 'message' => $messages[$state]];
}

function drivebay_gate_open_db($sqlitePath) {
    if ($sqlitePath === '' || !is_file($sqlitePath)) {
        return null;
    }
    try {
        $pdo = new PDO('sqlite:' . $sqlitePath, null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC]);
        $pdo->exec('PRAGMA busy_timeout = 5000');
        return $pdo;
    } catch (Exception $e) {
        return null;
    }
}

function drivebay_gate_known_machines($pdo) {
    if (!$pdo) {
        return [];
    }
    try {
        $rows = $pdo->query('SELECT DISTINCT machine_id FROM drivebay_machines')->fetchAll(PDO::FETCH_COLUMN);
        return is_array($rows) ? $rows : [];
    } catch (Exception $e) {
        return [];
    }
}

function drivebay_gate_incoming_ids($body) {
    $ids = [];
    if (!is_array($body)) {
        return $ids;
    }
    if (isset($body['envelopes']) && is_array($body['envelopes'])) {
        foreach ($body['envelopes'] as $item) {
            if (is_array($item) && isset($item['machineId'])) {
                $ids[] = (string) $item['machineId'];
            }
        }
        return $ids;
    }
    if (isset($body['machineId'])) {
        $ids[] = (string) $body['machineId'];
    }
    return $ids;
}

/**
 * Decide whether a request that may register machines is allowed.
 * @return array|null null = allow, otherwise ['status'=>402, 'code'=>..., 'error'=>...]
 */
function drivebay_gate_decide($eval, $knownIds, $incomingIds) {
    $new = [];
    foreach ($incomingIds as $id) {
        if (!in_array($id, $knownIds, true) && !in_array($id, $new, true)) {
            $new[] = $id;
        }
    }
    if (!$new) {
        return null;
    }
    if ($eval['state'] !== 'ok') {
        return ['status' => 402, 'code' => $eval['state'], 'error' => $eval['message'] . ' New machines cannot be added right now.'];
    }
    $seats = (int) $eval['license']['seats'];
    if (count($knownIds) + count($new) > $seats) {
        return ['status' => 402, 'code' => 'seats_full', 'error' => 'This Enterprise license covers ' . $seats . ' machines and ' . count($knownIds) . ' are registered. Remove a machine or ask Mesa and Moon for more seats.'];
    }
    return null;
}

function drivebay_gate_status($eval, $knownIds) {
    $l = $eval['license'];
    return [
        'ok' => $eval['state'] === 'ok',
        'state' => $eval['state'],
        'message' => $eval['message'],
        'licensee' => $l ? $l['label'] : null,
        'seats' => $l ? $l['seats'] : null,
        'machinesRegistered' => count($knownIds),
        'expires' => $l && $l['expires'] ? gmdate('Y-m-d', $l['expires']) : null,
        'updatesUntil' => $l && $l['updatesUntil'] ? gmdate('Y-m-d', $l['updatesUntil']) : null,
        'licenseId' => $l ? $l['id'] : null,
    ];
}

/** Entry point from the auto-prepend file. Exits with a JSON 402 when a new machine must be refused. */
function drivebay_gate_run($publicKeys = null) {
    $script = isset($_SERVER['SCRIPT_NAME']) ? basename((string) $_SERVER['SCRIPT_NAME']) : '';
    $method = isset($_SERVER['REQUEST_METHOD']) ? $_SERVER['REQUEST_METHOD'] : 'GET';
    $file = getenv('DRIVEBAY_LICENSE_FILE') ?: '/data/license.dbaylicense';
    $sqlite = getenv('DRIVEBAY_SQLITE_PATH') ?: '/data/drivebay.sqlite';
    $buildTs = null;
    $buildFile = getenv('DRIVEBAY_BUILD_TS_FILE') ?: dirname(__DIR__) . '/BUILD_TS';
    if (is_file($buildFile)) {
        $buildTs = (int) trim((string) file_get_contents($buildFile)) ?: null;
    }
    $eval = drivebay_gate_evaluate($file, drivebay_gate_public_keys($publicKeys), time(), $buildTs);
    $known = drivebay_gate_known_machines(drivebay_gate_open_db($sqlite));
    header('X-Drivebay-License: ' . $eval['state']);
    if ($script === 'enterprise-license.php') {
        header('Content-Type: application/json; charset=utf-8');
        header('Cache-Control: no-store');
        echo json_encode(drivebay_gate_status($eval, $known));
        exit;
    }
    if ($script !== 'machines.php' || !in_array($method, ['POST', 'PUT'], true)) {
        return;
    }
    $body = json_decode((string) file_get_contents('php://input'), true);
    $deny = drivebay_gate_decide($eval, $known, drivebay_gate_incoming_ids($body));
    if ($deny) {
        http_response_code($deny['status']);
        header('Content-Type: application/json; charset=utf-8');
        header('Cache-Control: no-store');
        echo json_encode(['error' => $deny['error'], 'code' => $deny['code'], 'upgrade' => true]);
        exit;
    }
}
