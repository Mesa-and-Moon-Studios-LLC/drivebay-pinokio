<?php

/**
 * Checkout providers (pluggable), the order webhook handler and the mail outbox.
 *
 * Providers: stripe (Payment Links / Checkout), lemonsqueezy, fake (tests only).
 * A provider is enabled only when its webhook secret is present in config.json. Until Aaron picks one
 * and creates the account, every provider except an explicitly configured fake one answers 503.
 *
 * Email: messages are written to the outbox table. Nothing is sent unless config.json has
 * "mail": {"enabled": true} AND a mailer callable is available. The default is the outbox only.
 */

require_once __DIR__ . '/license_store.php';

function drivebay_provider_config($ctx, $provider) {
    $providers = isset($ctx['config']['providers']) && is_array($ctx['config']['providers']) ? $ctx['config']['providers'] : [];
    $cfg = isset($providers[$provider]) && is_array($providers[$provider]) ? $providers[$provider] : null;
    if ($cfg === null || empty($cfg['webhook_secret'])) {
        return null;
    }
    return $cfg;
}

function drivebay_provider_verify($provider, $rawBody, $headers, $secret, $now) {
    $h = [];
    foreach ($headers as $k => $v) {
        $h[strtolower($k)] = $v;
    }
    if ($provider === 'stripe') {
        $sig = isset($h['stripe-signature']) ? $h['stripe-signature'] : '';
        $t = null;
        $v1 = [];
        foreach (explode(',', $sig) as $part) {
            $kv = explode('=', trim($part), 2);
            if (count($kv) === 2) {
                if ($kv[0] === 't') {
                    $t = (int) $kv[1];
                } elseif ($kv[0] === 'v1') {
                    $v1[] = $kv[1];
                }
            }
        }
        if ($t === null || abs($now - $t) > 300) {
            return false;
        }
        $expected = hash_hmac('sha256', $t . '.' . $rawBody, $secret);
        foreach ($v1 as $candidate) {
            if (hash_equals($expected, $candidate)) {
                return true;
            }
        }
        return false;
    }
    if ($provider === 'lemonsqueezy') {
        $sig = isset($h['x-signature']) ? $h['x-signature'] : '';
        return $sig !== '' && hash_equals(hash_hmac('sha256', $rawBody, $secret), $sig);
    }
    if ($provider === 'fake') {
        $sig = isset($h['x-fake-signature']) ? $h['x-fake-signature'] : '';
        return $sig !== '' && hash_equals(hash_hmac('sha256', $rawBody, $secret), $sig);
    }
    return false;
}

/**
 * @return array|null normalised event: eventId, type (paid|refunded|ignore), orderId, paymentRef, email, sku, quantity, variant, paymentLink
 */
function drivebay_provider_parse($provider, $rawBody) {
    $d = json_decode($rawBody, true);
    if (!is_array($d)) {
        return null;
    }
    if ($provider === 'fake') {
        return [
            'eventId' => (string) ($d['id'] ?? ''),
            'type' => in_array($d['type'] ?? '', ['paid', 'refunded'], true) ? $d['type'] : 'ignore',
            'orderId' => (string) ($d['order_id'] ?? ''),
            'paymentRef' => (string) ($d['payment_ref'] ?? ''),
            'email' => (string) ($d['email'] ?? ''),
            'sku' => (string) ($d['sku'] ?? ''),
            'quantity' => max(1, (int) ($d['quantity'] ?? 1)),
            'variant' => '', 'paymentLink' => '',
        ];
    }
    if ($provider === 'stripe') {
        $type = (string) ($d['type'] ?? '');
        $obj = isset($d['data']['object']) && is_array($d['data']['object']) ? $d['data']['object'] : [];
        $base = ['eventId' => (string) ($d['id'] ?? ''), 'type' => 'ignore', 'orderId' => '', 'paymentRef' => '', 'email' => '', 'sku' => '', 'quantity' => 1, 'variant' => '', 'paymentLink' => ''];
        if ($type === 'checkout.session.completed' && (($obj['payment_status'] ?? '') === 'paid' || ($obj['payment_status'] ?? '') === 'no_payment_required')) {
            return array_merge($base, [
                'type' => 'paid',
                'orderId' => (string) ($obj['id'] ?? ''),
                'paymentRef' => (string) ($obj['payment_intent'] ?? ''),
                'email' => (string) ($obj['customer_details']['email'] ?? ($obj['customer_email'] ?? '')),
                'sku' => (string) ($obj['metadata']['sku'] ?? ''),
                'quantity' => max(1, (int) ($obj['metadata']['quantity'] ?? 1)),
                'paymentLink' => (string) ($obj['payment_link'] ?? ''),
            ]);
        }
        if ($type === 'charge.refunded') {
            return array_merge($base, ['type' => 'refunded', 'paymentRef' => (string) ($obj['payment_intent'] ?? '')]);
        }
        return $base;
    }
    if ($provider === 'lemonsqueezy') {
        $name = (string) ($d['meta']['event_name'] ?? '');
        $attrs = isset($d['data']['attributes']) ? $d['data']['attributes'] : [];
        $orderId = (string) ($d['data']['id'] ?? '');
        $base = ['eventId' => $name . ':' . $orderId, 'type' => 'ignore', 'orderId' => $orderId, 'paymentRef' => '', 'email' => (string) ($attrs['user_email'] ?? ''), 'sku' => (string) ($d['meta']['custom_data']['sku'] ?? ''), 'quantity' => max(1, (int) ($attrs['first_order_item']['quantity'] ?? 1)), 'variant' => (string) ($attrs['first_order_item']['variant_id'] ?? ''), 'paymentLink' => ''];
        if ($name === 'order_created' && ($attrs['status'] ?? 'paid') === 'paid') {
            $base['type'] = 'paid';
        } elseif ($name === 'order_refunded') {
            $base['type'] = 'refunded';
        }
        return $base;
    }
    return null;
}

function drivebay_resolve_product($ctx, $event) {
    $products = isset($ctx['config']['products']) && is_array($ctx['config']['products']) ? $ctx['config']['products'] : [];
    if ($event['sku'] !== '' && isset($products[$event['sku']])) {
        return [$event['sku'], $products[$event['sku']]];
    }
    foreach ($products as $sku => $p) {
        if ($event['paymentLink'] !== '' && ($p['stripe_payment_link'] ?? '') === $event['paymentLink']) {
            return [$sku, $p];
        }
        if ($event['variant'] !== '' && (string) ($p['lemonsqueezy_variant'] ?? '') === $event['variant']) {
            return [$sku, $p];
        }
    }
    return [null, null];
}

function drivebay_mail_queue($ctx, $to, $subject, $body) {
    $transport = 'outbox';
    $sentAt = null;
    $mail = isset($ctx['config']['mail']) && is_array($ctx['config']['mail']) ? $ctx['config']['mail'] : [];
    if (!empty($mail['enabled']) && isset($ctx['mailer']) && is_callable($ctx['mailer'])) {
        // Only reachable when Aaron has explicitly switched mail on in config.json.
        $ok = call_user_func($ctx['mailer'], $to, $subject, $body, $mail);
        if ($ok) {
            $transport = 'sent';
            $sentAt = $ctx['now'];
        }
    }
    $ctx['pdo']->prepare('INSERT INTO outbox (to_email, subject, body, created_at, sent_at, transport) VALUES (?,?,?,?,?,?)')
        ->execute([$to, $subject, $body, $ctx['now'], $sentAt, $transport]);
}

function drivebay_order_email_body($codes, $productName) {
    $lines = [
        'Thank you for buying Drivebay ' . $productName . '.',
        '',
        count($codes) > 1 ? 'Your purchase codes:' : 'Your purchase code:',
        '',
    ];
    foreach ($codes as $c) {
        $lines[] = '    ' . $c;
    }
    $lines[] = '';
    $lines[] = 'To activate: open Drivebay, go to Settings, then Edition, paste the code and press Activate.';
    $lines[] = 'On the phone: open Drivebay, tap Edition, paste the code.';
    $lines[] = 'The same code works on each of your devices up to your seat count. To move a seat, press Deactivate on the old device first.';
    $lines[] = '';
    $lines[] = 'Keep this email. If you lose the code, write to projects@mesaandmoon.com with your order details.';
    return implode("\n", $lines);
}

/**
 * Handle one verified, parsed event. Idempotent per (provider, event id) and per (provider, order id).
 * @return array [httpStatus, body]
 */
function drivebay_handle_order_event($ctx, $provider, $event) {
    $pdo = $ctx['pdo'];
    if ($event === null || $event['eventId'] === '') {
        return [400, ['error' => 'Event has no id.']];
    }
    $pdo->beginTransaction();
    try {
        $stmt = $pdo->prepare('INSERT OR IGNORE INTO webhook_events (provider, event_id, received_at, outcome) VALUES (?,?,?,?)');
        $stmt->execute([$provider, $event['eventId'], $ctx['now'], 'processing']);
        if ($stmt->rowCount() === 0) {
            $pdo->commit();
            return [200, ['ok' => true, 'duplicate' => true]];
        }
        $outcome = 'ignored';
        if ($event['type'] === 'paid') {
            if ($event['orderId'] === '') {
                throw new DrivebayLicenseError('bad_event', 400, 'Paid event has no order id.');
            }
            $stmt = $pdo->prepare('SELECT 1 FROM orders WHERE provider = ? AND order_id = ?');
            $stmt->execute([$provider, $event['orderId']]);
            if ($stmt->fetchColumn()) {
                $outcome = 'order_exists';
            } else {
                [$sku, $product] = drivebay_resolve_product($ctx, $event);
                if ($product === null) {
                    throw new DrivebayLicenseError('unknown_sku', 422, 'That product is not mapped to an edition yet.');
                }
                $codes = [];
                $hashes = [];
                $qty = min(50, max(1, (int) $event['quantity']));
                for ($i = 0; $i < $qty; $i++) {
                    [$code, $hash] = drivebay_code_create($ctx, [
                        'kind' => 'purchase', 'edition' => $product['edition'], 'seats' => $product['seats'] ?? 1,
                        'termMonths' => $product['termMonths'] ?? 0,
                        'updatesMonths' => array_key_exists('updatesMonths', $product) ? $product['updatesMonths'] : null,
                        'label' => $product['label'] ?? '',
                    ], $provider . ':' . $event['orderId']);
                    $codes[] = $code;
                    $hashes[] = $hash;
                }
                $pdo->prepare('INSERT INTO orders (provider, order_id, payment_ref, email, sku, code_hashes, status, created_at) VALUES (?,?,?,?,?,?,?,?)')
                    ->execute([$provider, $event['orderId'], $event['paymentRef'], $event['email'], $sku, json_encode($hashes), 'paid', $ctx['now']]);
                if ($event['email'] !== '') {
                    drivebay_mail_queue($ctx, $event['email'], 'Your Drivebay purchase code', drivebay_order_email_body($codes, $product['name'] ?? ucfirst($product['edition'])));
                }
                $outcome = 'minted:' . count($codes);
            }
        } elseif ($event['type'] === 'refunded') {
            $stmt = $pdo->prepare("SELECT * FROM orders WHERE (provider = ? AND order_id = ?) OR (provider = ? AND payment_ref != '' AND payment_ref = ?)");
            $stmt->execute([$provider, $event['orderId'], $provider, $event['paymentRef']]);
            $order = $stmt->fetch();
            if ($order && $order['refunded_at'] === null) {
                foreach (json_decode($order['code_hashes'], true) ?: [] as $hash) {
                    $pdo->prepare('UPDATE codes SET disabled_at = ? WHERE code_hash = ? AND disabled_at IS NULL')->execute([$ctx['now'], $hash]);
                    $r = $pdo->prepare('SELECT license_id FROM code_redemptions WHERE code_hash = ?');
                    $r->execute([$hash]);
                    foreach ($r->fetchAll() as $row) {
                        drivebay_license_revoke($ctx, $row['license_id'], 'Refunded');
                    }
                }
                $pdo->prepare('UPDATE orders SET status = ?, refunded_at = ? WHERE provider = ? AND order_id = ?')->execute(['refunded', $ctx['now'], $order['provider'], $order['order_id']]);
                $outcome = 'refunded';
            } else {
                $outcome = $order ? 'already_refunded' : 'refund_unknown_order';
            }
        }
        $pdo->prepare('UPDATE webhook_events SET outcome = ? WHERE provider = ? AND event_id = ?')->execute([$outcome, $provider, $event['eventId']]);
        $pdo->commit();
        return [200, ['ok' => true, 'outcome' => $outcome]];
    } catch (DrivebayLicenseError $err) {
        $pdo->rollBack();
        return [$err->status, ['error' => $err->getMessage(), 'code' => $err->code_name]];
    } catch (Throwable $err) {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
        throw $err;
    }
}
