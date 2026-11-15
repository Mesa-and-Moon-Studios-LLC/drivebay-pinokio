<?php
require dirname(__DIR__) . '/lib/bootstrap.php';
require dirname(__DIR__) . '/lib/machines.php';

$user = drivebay_bearer();
$uid = $user['sub'];
$method = isset($_SERVER['REQUEST_METHOD']) ? $_SERVER['REQUEST_METHOD'] : 'GET';

try {
    $pdo = drivebay_pdo();
} catch (Exception $err) {
    drivebay_fail(500, 'Cloud API database is not available.');
}

if ($method === 'GET') {
    $self = isset($_GET['self']) ? (string) $_GET['self'] : '';
    drivebay_json(['machines' => drivebay_list_machines($pdo, $uid, $self)]);
}

if ($method === 'POST') {
    $clean = drivebay_sanitize_machine(drivebay_body());
    if ($clean === null) {
        drivebay_fail(400, 'That record is not connection info.');
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
