<?php
require dirname(__DIR__) . '/lib/bootstrap.php';
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
    drivebay_json([
        'ok' => true,
        'locked' => drivebay_vault_locked($pdo, $uid),
        'wraps' => drivebay_list_wraps($pdo, $uid),
        'cannotRecover' => true,
    ]);
}

if ($method === 'POST') {
    $body = drivebay_body();
    $wraps = isset($body['wraps']) && is_array($body['wraps']) ? $body['wraps'] : null;
    if ($wraps === null) {
        drivebay_fail(400, 'Send the wrapped keys for this account.');
    }
    if (!drivebay_replace_wraps($pdo, $uid, $wraps)) {
        drivebay_fail(400, 'Those wrap records were not accepted. A recovery passphrase or recovery key is required.');
    }
    drivebay_json(['ok' => true, 'locked' => true, 'wraps' => drivebay_list_wraps($pdo, $uid)]);
}

drivebay_fail(405, 'Method not allowed.');
