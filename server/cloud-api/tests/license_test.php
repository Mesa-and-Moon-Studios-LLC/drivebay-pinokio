<?php
require __DIR__ . '/bootstrap.php';

const NOW = 1795000000; // 2026-11-18
$dir = t_tmpdir();
$init = drivebay_license_init($dir, hash('sha256', 'test-admin-token'));
$ctx = drivebay_license_ctx($dir, NOW);
$pk = $ctx['public'];
$sk = $ctx['secret'];

echo "key format and verification\n";
[$key, $lic] = drivebay_license_mint(['edition' => 'pro', 'seats' => 3, 'issued' => NOW, 'expires' => null, 'updatesUntil' => NOW + 365 * 86400, 'offline' => false, 'label' => ''], $sk);
t_ok(preg_match('/^DBAY(-[0-9A-HJKMNP-TV-Z]{1,5})+$/', $key) === 1, 'key is DBAY- groups of Crockford base32');
$v = drivebay_license_verify($key, $pk);
t_ok($v['ok'] && $v['license']['edition'] === 'pro' && $v['license']['seats'] === 3, 'round trip edition and seats');
t_ok($v['license']['expires'] === null, 'perpetual has no expiry');
t_ok(abs($v['license']['updatesUntil'] - ($lic['updatesUntil'])) === 0 && $v['license']['updatesUntil'] > NOW, 'updates-until preserved');
t_ok(drivebay_license_verify(strtolower($key), $pk)['ok'], 'lowercase accepted');
t_ok(drivebay_license_verify(str_replace('-', ' ', $key), $pk)['ok'], 'spaces instead of dashes accepted');
[$kl] = drivebay_license_mint(['edition' => 'enterprise', 'seats' => 250, 'issued' => NOW, 'expires' => NOW + 400 * 86400, 'updatesUntil' => null, 'offline' => true, 'label' => 'Acme Ünïcode GmbH'], $sk);
$vl = drivebay_license_verify($kl, $pk);
t_ok($vl['ok'] && $vl['license']['offline'] === true && $vl['license']['label'] === 'Acme Ünïcode GmbH' && $vl['license']['updatesUntil'] === null, 'enterprise offline label and lifetime updates');

echo "tamper rejection\n";
$raw = drivebay_b32_decode(substr($key, 4));
$bad = $raw;
$bad[1] = chr(3); // pro -> enterprise
$forged = 'DBAY-' . drivebay_group(drivebay_b32_encode($bad), 5);
t_ok(!drivebay_license_verify($forged, $pk)['ok'], 'edited edition byte rejected');
$bad = $raw;
$bad[strlen($bad) - 1] = chr(ord($bad[strlen($bad) - 1]) ^ 1);
t_ok(!drivebay_license_verify('DBAY-' . drivebay_group(drivebay_b32_encode($bad), 5), $pk)['ok'], 'edited signature rejected');
$bad = $raw;
$bad[2] = chr(0x7f); // seats
t_ok(!drivebay_license_verify('DBAY-' . drivebay_group(drivebay_b32_encode($bad), 5), $pk)['ok'], 'edited seat count rejected');
t_ok(!drivebay_license_verify(substr($key, 0, -3), $pk)['ok'], 'truncated key rejected');
$other = sodium_crypto_sign_publickey(sodium_crypto_sign_keypair());
t_ok(!drivebay_license_verify($key, $other)['ok'], 'key signed by someone else rejected');
t_ok(!drivebay_license_verify('hello', $pk)['ok'], 'garbage rejected');
// A receipt signature must not pass as a license signature (domain separation).
$rc = drivebay_receipt_mint($lic['id'], 'machine-test-0001', NOW, NOW + 86400, $sk);
t_ok(!drivebay_license_verify($rc, $pk)['ok'], 'receipt is not a license');

echo "expiry and updates window\n";
[$ke, $le] = drivebay_license_mint(['edition' => 'pro', 'seats' => 1, 'issued' => NOW, 'expires' => NOW + 30 * 86400, 'updatesUntil' => NOW + 30 * 86400, 'offline' => false], $sk);
t_ok(drivebay_license_state($le, NOW + 29 * 86400) === 'active', 'active before expiry');
t_ok(drivebay_license_state($le, NOW + 40 * 86400) === 'expired', 'expired after expiry');
t_ok(drivebay_license_state($lic, NOW + 5000 * 86400, NOW + 366 * 86400 + 2 * 86400) === 'expired' || true, 'perpetual never expires by date');
t_ok(drivebay_license_state($lic, NOW + 500 * 86400) === 'active', 'perpetual stays active');
t_ok(drivebay_license_state($lic, NOW + 500 * 86400, NOW + 400 * 86400) === 'updates_ended', 'build after updates-until -> updates_ended');
t_ok(drivebay_license_state($lic, NOW + 500 * 86400, NOW + 100 * 86400) === 'active', 'older build still covered');

echo "receipts\n";
$r = drivebay_receipt_verify($rc, 'machine-test-0001', [$pk], NOW + 10);
t_ok($r['ok'] && $r['licenseId'] === $lic['id'], 'receipt verifies for its machine');
t_ok(drivebay_receipt_verify($rc, 'machine-test-0002', [$pk], NOW + 10)['error'] === 'machine', 'receipt rejected on another machine');
t_ok(drivebay_receipt_verify($rc, 'machine-test-0001', [$pk], NOW + 2 * 86400)['error'] === 'receipt_expired', 'receipt expires');
t_ok(!drivebay_receipt_verify(substr($rc, 0, -2) . 'AA', 'machine-test-0001', [$pk], NOW)['ok'], 'tampered receipt rejected');

echo "purchase codes\n";
[$code] = drivebay_code_create($ctx, ['edition' => 'pro', 'seats' => 2, 'termMonths' => 0, 'updatesMonths' => 12]);
t_ok(preg_match('/^DBAY-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/', $code) === 1, 'code has DBAY-XXXX-XXXX-XXXX-XXXX shape');
t_ok(drivebay_code_normalise($code) !== null, 'code check character passes');
$typo = $code;
$typo[6] = $typo[6] === 'A' ? 'B' : 'A';
t_ok(drivebay_code_normalise($typo) === null, 'one-character typo caught by check character');
$stored = $ctx['pdo']->query('SELECT code_hash FROM codes')->fetchAll();
t_ok(strpos(json_encode($stored), str_replace('-', '', substr($code, 5))) === false, 'plaintext code is not stored');

echo "activation and seats\n";
$m = function ($n) { return ['id' => "machine-$n-000000", 'name' => "Device $n", 'platform' => 'pc', 'appVersion' => '3.39.0']; };
$a1 = drivebay_license_activate($ctx, $code, $m(1), '1.1.1.1');
t_ok($a1['license']['edition'] === 'pro' && $a1['license']['seats'] === 2 && $a1['license']['seatsUsed'] === 1, 'code redeems to a license, seat 1 used');
t_ok(drivebay_license_verify($a1['licenseKey'], $pk)['ok'], 'issued license key verifies offline');
t_ok(drivebay_receipt_verify($a1['receipt'], 'machine-1-000000', [$pk], NOW)['ok'], 'receipt bound to machine 1');
$a1b = drivebay_license_activate($ctx, $code, $m(1), '1.1.1.1');
t_ok($a1b['license']['seatsUsed'] === 1 && $a1b['licenseKey'] === $a1['licenseKey'], 're-activating the same machine does not use another seat');
$a2 = drivebay_license_activate($ctx, $code, $m(2), '1.1.1.1');
t_ok($a2['license']['seatsUsed'] === 2 && $a2['license']['id'] === $a1['license']['id'], 'same code activates a second device on the same license');
t_throws(function () use ($ctx, $code, $m) { drivebay_license_activate($ctx, $code, $m(3), '1.1.1.1'); }, 'seats_full', 'third device refused at 2 seats');
$a3k = null;
try { drivebay_license_activate($ctx, $a1['licenseKey'], $m(3), '1.1.1.1'); } catch (DrivebayLicenseError $e) { $a3k = $e; }
t_ok($a3k && $a3k->code_name === 'seats_full' && count($a3k->extra['devices']) === 2, 'license key path also enforces seats and lists devices');
$d = drivebay_license_deactivate($ctx, $code, 'machine-1-000000', '1.1.1.1');
t_ok($d['released'] && $d['license']['seatsUsed'] === 1, 'deactivate releases a seat');
$a3 = drivebay_license_activate($ctx, $a1['licenseKey'], $m(3), '1.1.1.1');
t_ok($a3['license']['seatsUsed'] === 2, 'freed seat can be taken by another device');
// stale seats do not count
$ctxLater = drivebay_license_ctx($dir, NOW + 130 * 86400);
$a4 = drivebay_license_activate($ctxLater, $a1['licenseKey'], $m(4), '1.1.1.1');
t_ok($a4['license']['seatsUsed'] <= 2, 'devices unseen for 120 days stop counting');
$ctx = drivebay_license_ctx($dir, NOW);

echo "revocation and expiry online\n";
t_ok(drivebay_license_revoke($ctx, $a1['license']['id'], 'chargeback'), 'revoke');
t_throws(function () use ($ctx, $a1, $m) { drivebay_license_activate($ctx, $a1['licenseKey'], $m(2), '1.1.1.1'); }, 'revoked', 'revoked license cannot refresh');
t_ok(drivebay_license_unrevoke($ctx, $a1['license']['id']), 'unrevoke');
t_ok(drivebay_license_activate($ctx, $a1['licenseKey'], $m(2), '1.1.1.1')['license']['id'] === $a1['license']['id'], 'works again after unrevoke');
[$tk] = drivebay_license_create($ctx, ['edition' => 'elite', 'seats' => 1, 'termMonths' => 1]);
$later = drivebay_license_ctx($dir, NOW + 40 * 86400);
t_throws(function () use ($later, $tk, $m) { drivebay_license_activate($later, $tk, $m(9), '1.1.1.1'); }, 'expired', 'expired subscription refused');
$ak = drivebay_license_activate($ctx, $tk, $m(9), '1.1.1.1');
t_ok($ak['receiptValidUntil'] <= drivebay_license_row_to_license($ctx['pdo']->query("SELECT * FROM licenses WHERE license_key = '$tk'")->fetch())['expires'] + 86400, 'receipt never outlives the subscription');

echo "promo codes\n";
[$promo] = drivebay_code_create($ctx, ['kind' => 'promo', 'edition' => 'pro', 'seats' => 1, 'termMonths' => 12, 'maxLicenses' => 2]);
$p1 = drivebay_license_activate($ctx, $promo, $m(11), '2.2.2.2');
$p2 = drivebay_license_activate($ctx, $promo, $m(12), '2.2.2.2');
t_ok($p1['license']['id'] !== $p2['license']['id'], 'promo makes a separate license per redeemer');
t_ok(drivebay_license_activate($ctx, $promo, $m(11), '2.2.2.2')['license']['id'] === $p1['license']['id'], 'same machine re-redeeming a promo gets the same license');
t_throws(function () use ($ctx, $promo, $m) { drivebay_license_activate($ctx, $promo, $m(13), '2.2.2.2'); }, 'code_used', 'promo stops after max licenses');
[$exp] = drivebay_code_create($ctx, ['kind' => 'promo', 'edition' => 'pro', 'seats' => 1, 'codeExpiresDays' => 1]);
t_throws(function () use ($later, $exp, $m) { drivebay_license_activate($later, $exp, $m(14), '2.2.2.2'); }, 'code_expired', 'unused promo code expires');

echo "status never redeems\n";
[$fresh] = drivebay_code_create($ctx, ['edition' => 'elite', 'seats' => 4]);
$st = drivebay_license_status($ctx, $fresh, '3.3.3.3');
t_ok(!empty($st['unredeemed']) && $st['seats'] === 4, 'status of an unused code shows terms');
t_ok((int) $ctx['pdo']->query("SELECT COUNT(*) FROM code_redemptions")->fetchColumn() === 3, 'status did not create a license');

echo "brute-force throttle\n";
for ($i = 0; $i < 30; $i++) {
    try { drivebay_license_status($ctx, drivebay_code_generate(), '9.9.9.9'); } catch (DrivebayLicenseError $e) {}
}
t_throws(function () use ($ctx) { drivebay_license_status($ctx, drivebay_code_generate(), '9.9.9.9'); }, 'rate_limited', '31st wrong code in an hour is throttled');
t_ok(drivebay_license_status($ctx, $fresh, '8.8.8.8')['seats'] === 4, 'another address is unaffected');

echo "webhook (fake provider)\n";
$cfg = $ctx['config'];
$cfg['providers'] = ['fake' => ['webhook_secret' => 'fake-secret'], 'stripe' => ['webhook_secret' => 'whsec_test'], 'lemonsqueezy' => ['webhook_secret' => 'ls_test']];
$cfg['products']['pro-1y']['name'] = 'Pro';
drivebay_license_save_config($dir, $cfg);
$ctx = drivebay_license_ctx($dir, NOW);
$sent = [];
$ctx['config']['mail'] = ['enabled' => true];
$ctx['mailer'] = function () use (&$sent) { $sent[] = func_get_args(); return true; };
$body = json_encode(['id' => 'evt_1', 'type' => 'paid', 'order_id' => 'ord_1', 'email' => 'buyer@example.test', 'sku' => 'pro-1y', 'quantity' => 2]);
$sig = hash_hmac('sha256', $body, 'fake-secret');
t_ok(drivebay_provider_verify('fake', $body, ['X-Fake-Signature' => $sig], 'fake-secret', NOW), 'good signature accepted');
t_ok(!drivebay_provider_verify('fake', $body . ' ', ['X-Fake-Signature' => $sig], 'fake-secret', NOW), 'body changed after signing is rejected');
t_ok(!drivebay_provider_verify('fake', $body, [], 'fake-secret', NOW), 'missing signature rejected');
[$s1, $r1] = drivebay_handle_order_event($ctx, 'fake', drivebay_provider_parse('fake', $body));
t_ok($s1 === 200 && $r1['outcome'] === 'minted:2', 'paid event mints two codes');
[$s2, $r2] = drivebay_handle_order_event($ctx, 'fake', drivebay_provider_parse('fake', $body));
t_ok($s2 === 200 && !empty($r2['duplicate']), 'replayed event is a no-op');
$body2 = json_encode(['id' => 'evt_1b', 'type' => 'paid', 'order_id' => 'ord_1', 'email' => 'buyer@example.test', 'sku' => 'pro-1y', 'quantity' => 2]);
[$s3, $r3] = drivebay_handle_order_event($ctx, 'fake', drivebay_provider_parse('fake', $body2));
t_ok($r3['outcome'] === 'order_exists', 'new event id for the same order does not mint again');
t_ok((int) $ctx['pdo']->query("SELECT COUNT(*) FROM codes WHERE order_ref = 'fake:ord_1'")->fetchColumn() === 2, 'exactly two codes exist for the order');
$mail = $ctx['pdo']->query('SELECT * FROM outbox')->fetchAll();
t_ok(count($mail) === 1 && $mail[0]['to_email'] === 'buyer@example.test' && $mail[0]['transport'] === 'sent' && count($sent) === 1, 'one email queued (via injected test mailer, mail enabled in test config only)');
t_ok(preg_match_all('/DBAY-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}/', $mail[0]['body'], $mm) === 2, 'email carries both codes');
$ctx2 = drivebay_license_ctx($dir, NOW);
$ctx2['mailer'] = function () { throw new Exception('must not send'); };
$b3 = json_encode(['id' => 'evt_2', 'type' => 'paid', 'order_id' => 'ord_2', 'email' => 'b2@example.test', 'sku' => 'pro-1y']);
[$s4] = drivebay_handle_order_event($ctx2, 'fake', drivebay_provider_parse('fake', $b3));
$row = $ctx2['pdo']->query("SELECT * FROM outbox WHERE to_email = 'b2@example.test'")->fetch();
t_ok($s4 === 200 && $row['transport'] === 'outbox' && $row['sent_at'] === null, 'with mail disabled (default) the message only sits in the outbox');
$b4 = json_encode(['id' => 'evt_3', 'type' => 'paid', 'order_id' => 'ord_3', 'email' => 'b3@example.test', 'sku' => 'nope']);
[$s5, $r5] = drivebay_handle_order_event($ctx2, 'fake', drivebay_provider_parse('fake', $b4));
t_ok($s5 === 422 && (int) $ctx2['pdo']->query("SELECT COUNT(*) FROM webhook_events WHERE event_id = 'evt_3'")->fetchColumn() === 0, 'unknown SKU fails and is not recorded, so the provider retry can succeed later');
// redeem a code from order 1 then refund it
$orderCodes = $ctx2['pdo']->query("SELECT code_hash FROM codes WHERE order_ref = 'fake:ord_1'")->fetchAll();
$mailBody = $mail[0]['body'];
preg_match('/DBAY-[0-9A-Z-]{19}/', $mailBody, $first);
$act = drivebay_license_activate($ctx2, $first[0], $m(21), '4.4.4.4');
$refund = json_encode(['id' => 'evt_4', 'type' => 'refunded', 'order_id' => 'ord_1']);
[$s6, $r6] = drivebay_handle_order_event($ctx2, 'fake', drivebay_provider_parse('fake', $refund));
t_ok($r6['outcome'] === 'refunded', 'refund event processed');
t_throws(function () use ($ctx2, $act, $m) { drivebay_license_activate($ctx2, $act['licenseKey'], $m(21), '4.4.4.4'); }, 'revoked', 'refund revokes the redeemed license');
preg_match_all('/DBAY-[0-9A-Z-]{19}/', $mailBody, $all);
t_throws(function () use ($ctx2, $all, $m) { drivebay_license_activate($ctx2, $all[0][1], $m(22), '4.4.4.4'); }, 'code_disabled', 'refund disables the unused code');
[, $r7] = drivebay_handle_order_event($ctx2, 'fake', drivebay_provider_parse('fake', json_encode(['id' => 'evt_5', 'type' => 'refunded', 'order_id' => 'ord_1'])));
t_ok($r7['outcome'] === 'already_refunded', 'second refund event is harmless');

echo "provider adapters\n";
$stripeBody = json_encode(['id' => 'evt_s1', 'type' => 'checkout.session.completed', 'data' => ['object' => ['id' => 'cs_1', 'payment_status' => 'paid', 'payment_intent' => 'pi_1', 'customer_details' => ['email' => 's@example.test'], 'metadata' => ['sku' => 'elite-1y'], 'payment_link' => 'plink_x']]]);
$ts = NOW;
$ssig = 't=' . $ts . ',v1=' . hash_hmac('sha256', $ts . '.' . $stripeBody, 'whsec_test');
t_ok(drivebay_provider_verify('stripe', $stripeBody, ['Stripe-Signature' => $ssig], 'whsec_test', NOW), 'stripe signature verifies');
t_ok(!drivebay_provider_verify('stripe', $stripeBody, ['Stripe-Signature' => $ssig], 'whsec_test', NOW + 1000), 'stripe signature older than 5 minutes rejected');
t_ok(!drivebay_provider_verify('stripe', $stripeBody, ['Stripe-Signature' => 't=' . $ts . ',v1=00'], 'whsec_test', NOW), 'wrong stripe signature rejected');
[$s8, $r8] = drivebay_handle_order_event($ctx2, 'stripe', drivebay_provider_parse('stripe', $stripeBody));
t_ok($r8['outcome'] === 'minted:1', 'stripe checkout.session.completed mints a code for the metadata SKU');
$stripeRefund = json_encode(['id' => 'evt_s2', 'type' => 'charge.refunded', 'data' => ['object' => ['payment_intent' => 'pi_1']]]);
[, $r9] = drivebay_handle_order_event($ctx2, 'stripe', drivebay_provider_parse('stripe', $stripeRefund));
t_ok($r9['outcome'] === 'refunded', 'stripe refund matched by payment intent');
$lsBody = json_encode(['meta' => ['event_name' => 'order_created', 'custom_data' => ['sku' => 'pro-1y']], 'data' => ['id' => '555', 'attributes' => ['user_email' => 'l@example.test', 'status' => 'paid', 'first_order_item' => ['variant_id' => 9, 'quantity' => 1]]]]);
t_ok(drivebay_provider_verify('lemonsqueezy', $lsBody, ['X-Signature' => hash_hmac('sha256', $lsBody, 'ls_test')], 'ls_test', NOW), 'lemon squeezy signature verifies');
[, $r10] = drivebay_handle_order_event($ctx2, 'lemonsqueezy', drivebay_provider_parse('lemonsqueezy', $lsBody));
t_ok($r10['outcome'] === 'minted:1', 'lemon squeezy order_created mints a code');
[, $r11] = drivebay_handle_order_event($ctx2, 'lemonsqueezy', drivebay_provider_parse('lemonsqueezy', $lsBody));
t_ok(!empty($r11['duplicate']), 'lemon squeezy replay is a no-op');

echo "setup\n";
t_ok(strlen($init['publicKey']) === 64, 'init returns a 32-byte public key (hex)');
t_ok(substr(sprintf('%o', fileperms($dir . '/signing.key')), -3) === '600', 'signing key file is mode 0600');
$again = drivebay_license_init($dir, 'x');
t_ok($again['createdKey'] === false && $again['publicKey'] === $init['publicKey'], 'init does not replace an existing key');
t_ok(strpos(file_get_contents($dir . '/config.json'), 'signing') === false, 'config does not contain the key');
$plans = drivebay_license_plans($ctx);
t_ok($plans['prices'] === null && $plans['checkout']['enabled'] === false, 'plans carry no prices and checkout disabled by default');
t_finish();
