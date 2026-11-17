<?php
require dirname(__DIR__) . '/lib/bootstrap.php';
require dirname(__DIR__) . '/lib/machines.php';
require dirname(__DIR__) . '/lib/vault.php';

$user = drivebay_bearer();
$uid = $user['sub'];
$method = isset($_SERVER['REQUEST_METHOD']) ? $_SERVER['REQUEST_METHOD'] : 'GET';

try {
    $pdo = drivebay_pdo();
} catch (Exception $err) {
    drivebay_log('Cloud API database is not available.');
    drivebay_fail(500, 'Cloud API database is not available.');
}

if ($method === 'GET') {
    $self = isset($_GET['self']) ? (string) $_GET['self'] : '';
    $locked = drivebay_vault_locked($pdo, $uid);
    drivebay_json([
        'machines' => drivebay_list_machines($pdo, $uid, $self),
        'wraps' => $locked ? drivebay_list_wraps($pdo, $uid) : [],
        'locked' => $locked,
    ]);
}

if ($method === 'POST') {
    $locked = drivebay_vault_locked($pdo, $uid);
    $body = drivebay_body();
    // A batch of encrypted envelopes (used during migration).
    if (isset($body['envelopes']) && is_array($body['envelopes'])) {
        foreach ($body['envelopes'] as $item) {
            $clean = drivebay_sanitize_envelope($item);
            if ($clean === null) {
                drivebay_fail(400, 'That record is not an encrypted machine directory.');
            }
            drivebay_upsert_machine($pdo, $uid, $clean);
        }
        drivebay_json(['ok' => true]);
    }
    $clean = drivebay_accept_machine($body, $locked);
    if ($clean === null) {
        drivebay_fail(400, $locked ? 'That record is not an encrypted machine directory.' : 'That record is not connection info.');
    }
    drivebay_upsert_machine($pdo, $uid, $clean);
    drivebay_json(['ok' => true]);
}

if ($method === 'DELETE') {
    $machineId = isset($_GET['machineId']) ? (string) $_GET['machineId'] : '';
    if (!preg_match('/^[A-Za-z0-9_-]{8,64}$/', $machineId)) {
        drivebay_fail(400, 'Machine id is invalid.');
    }
    drivebay_delete_machine($pdo, $uid, $machineId);
    drivebay_json(['ok' => true]);
}

drivebay_fail(405, 'Method not allowed.');
