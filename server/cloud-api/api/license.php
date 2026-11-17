<?php
/**
 * Drivebay licensing API (public). Activation, refresh, deactivation, status, plans.
 *
 * POST ?action=activate    {key, machineId, name, platform, appVersion}  key = purchase code or license key
 * POST ?action=refresh     same body (alias of activate; renews the receipt)
 * POST ?action=deactivate  {key, machineId}
 * POST ?action=status      {key}
 * GET  ?action=plans
 * GET  ?action=publickey
 * No Firebase sign-in is needed: the code or key is the credential. Files and file names never reach this server.
 */
require dirname(__DIR__) . '/lib/bootstrap.php';
require dirname(__DIR__) . '/lib/license_store.php';
require dirname(__DIR__) . '/lib/license_plans.php';

$method = isset($_SERVER['REQUEST_METHOD']) ? $_SERVER['REQUEST_METHOD'] : 'GET';
$action = isset($_GET['action']) ? (string) $_GET['action'] : '';
$ip = isset($_SERVER['REMOTE_ADDR']) ? $_SERVER['REMOTE_ADDR'] : '';

try {
    $ctx = drivebay_license_ctx();
} catch (DrivebayLicenseError $err) {
    drivebay_json(['error' => $err->getMessage(), 'code' => $err->code_name], $err->status);
} catch (Throwable $err) {
    drivebay_fail(500, 'Licensing is not available.');
}

try {
    if ($method === 'GET' && $action === 'plans') {
        drivebay_json(['ok' => true] + drivebay_license_plans($ctx));
    }
    if ($method === 'GET' && $action === 'publickey') {
        drivebay_json(['ok' => true, 'publicKey' => bin2hex($ctx['public']), 'alg' => 'Ed25519']);
    }
    if ($method !== 'POST') {
        drivebay_fail(405, 'Method not allowed.');
    }
    $body = drivebay_body();
    $key = isset($body['key']) ? (string) $body['key'] : '';
    if ($key === '' || strlen($key) > 1024) {
        drivebay_fail(400, 'Send a code or license key.');
    }
    if ($action === 'activate' || $action === 'refresh') {
        $result = drivebay_license_activate($ctx, $key, [
            'id' => isset($body['machineId']) ? $body['machineId'] : '',
            'name' => isset($body['name']) ? $body['name'] : '',
            'platform' => isset($body['platform']) ? $body['platform'] : '',
            'appVersion' => isset($body['appVersion']) ? $body['appVersion'] : '',
        ], $ip);
        drivebay_json(['ok' => true] + $result);
    }
    if ($action === 'deactivate') {
        $machineId = isset($body['machineId']) ? (string) $body['machineId'] : '';
        drivebay_json(drivebay_license_deactivate($ctx, $key, $machineId, $ip));
    }
    if ($action === 'status') {
        drivebay_json(['ok' => true, 'license' => drivebay_license_status($ctx, $key, $ip)]);
    }
    drivebay_fail(400, 'Unknown action.');
} catch (DrivebayLicenseError $err) {
    drivebay_json(['error' => $err->getMessage(), 'code' => $err->code_name] + $err->extra, $err->status);
} catch (Throwable $err) {
    error_log('drivebay license: ' . $err->getMessage());
    drivebay_fail(500, 'Licensing hit an error. Try again later.');
}
