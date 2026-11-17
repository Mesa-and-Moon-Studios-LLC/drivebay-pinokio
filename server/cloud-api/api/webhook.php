<?php
/**
 * Payment webhook. POST ?provider=stripe|lemonsqueezy|fake
 * Verifies the provider signature, mints purchase code(s), and queues the email in the outbox.
 * Idempotent per event id and per order id. A provider answers 503 until its webhook secret is in config.json.
 */
require dirname(__DIR__) . '/lib/bootstrap.php';
require dirname(__DIR__) . '/lib/license_orders.php';

if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'POST') {
    drivebay_fail(405, 'Method not allowed.');
}
$provider = isset($_GET['provider']) ? (string) $_GET['provider'] : '';
if (!in_array($provider, ['stripe', 'lemonsqueezy', 'fake'], true)) {
    drivebay_fail(400, 'Unknown provider.');
}
try {
    $ctx = drivebay_license_ctx();
    $cfg = drivebay_provider_config($ctx, $provider);
    if ($cfg === null) {
        drivebay_fail(503, 'This payment provider is not set up yet.');
    }
    $raw = file_get_contents('php://input');
    $headers = function_exists('getallheaders') ? getallheaders() : [];
    if (!$headers) {
        foreach ($_SERVER as $k => $v) {
            if (strpos($k, 'HTTP_') === 0) {
                $headers[str_replace('_', '-', substr($k, 5))] = $v;
            }
        }
    }
    if (!is_string($raw) || $raw === '' || strlen($raw) > 262144 || !drivebay_provider_verify($provider, $raw, $headers, $cfg['webhook_secret'], $ctx['now'])) {
        drivebay_fail(401, 'Signature did not verify.');
    }
    $event = drivebay_provider_parse($provider, $raw);
    [$status, $body] = drivebay_handle_order_event($ctx, $provider, $event);
    drivebay_json($body, $status);
} catch (DrivebayLicenseError $err) {
    drivebay_json(['error' => $err->getMessage(), 'code' => $err->code_name], $err->status);
} catch (Throwable $err) {
    error_log('drivebay webhook: ' . $err->getMessage());
    drivebay_fail(500, 'Webhook failed.');
}
