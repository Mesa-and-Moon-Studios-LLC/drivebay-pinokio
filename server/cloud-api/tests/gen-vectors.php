<?php
// Generates docs/license-test-vectors.json from a FIXED TEST SEED (never a production key).
require __DIR__ . '/bootstrap.php';
$seed = str_pad('drivebay-license-test-seed-ONLY', 32, '_');
$kp = sodium_crypto_sign_seed_keypair($seed);
$sk = sodium_crypto_sign_secretkey($kp);
$pk = sodium_crypto_sign_publickey($kp);
$issued = 1795000000; // 2026-11-18
$day = 86400;
$mk = function ($f) use ($sk, $issued) { return drivebay_license_mint($f + ['issued' => $issued, 'offline' => false, 'label' => ''], $sk); };
$cases = [];
$add = function ($name, $f) use ($mk, &$cases) {
    [$key, $lic] = $mk($f);
    $cases[] = ['name' => $name, 'key' => $key, 'expect' => $lic];
};
$add('pro perpetual, 12 months of updates', ['edition' => 'pro', 'seats' => 3, 'id' => '0102030405060708', 'expires' => null, 'updatesUntil' => $issued + 365 * $day]);
$add('elite yearly subscription', ['edition' => 'elite', 'seats' => 10, 'id' => 'a1a2a3a4a5a6a7a8', 'expires' => $issued + 365 * $day, 'updatesUntil' => $issued + 365 * $day]);
[$k, $l] = drivebay_license_mint(['edition' => 'enterprise', 'seats' => 500, 'id' => 'ffeeddccbbaa9988', 'issued' => $issued, 'expires' => null, 'updatesUntil' => null, 'offline' => true, 'label' => 'Acme Ünïcode GmbH'], $sk);
$cases[] = ['name' => 'enterprise offline, lifetime updates, UTF-8 label', 'key' => $k, 'expect' => $l];
$machine = 'test-machine-0001';
$receipt = drivebay_receipt_mint('0102030405060708', $machine, $issued, $issued + 30 * $day, $sk);
$raw = drivebay_b32_decode(substr($cases[0]['key'], 4));
$bad = $raw; $bad[1] = chr(3);
$code = 'DBAY-' . implode('-', str_split('0123456789ABCDE', 4));
$out = [
    'note' => 'Test vectors for Drivebay license keys. The signing seed is a public test value and must never be a production key.',
    'publicKeyHex' => bin2hex($pk),
    'issued' => $issued,
    'licenses' => $cases,
    'tamperedKeys' => [
        ['name' => 'edition byte changed from pro to enterprise', 'key' => 'DBAY-' . drivebay_group(drivebay_b32_encode($bad), 5)],
        ['name' => 'truncated', 'key' => substr($cases[0]['key'], 0, -5)],
        ['name' => 'not a key', 'key' => 'DBAY-HELLO-WORLD'],
    ],
    'receipt' => ['machineId' => $machine, 'otherMachineId' => 'test-machine-0002', 'licenseId' => '0102030405060708', 'text' => $receipt, 'issuedAt' => $issued, 'validUntil' => $issued + 30 * $day],
    'purchaseCodes' => [
        ['code' => 'DBAY-' . implode('-', str_split(($c15 = '0123456789ABCDE') . drivebay_code_check_char($c15), 4)), 'valid' => true],
        ['code' => 'DBAY-' . implode('-', str_split($c15 . (drivebay_code_check_char($c15) === 'Z' ? 'Y' : 'Z'), 4)), 'valid' => false],
        ['code' => 'DBAY-0123-4567-89AB-CDEF', 'valid' => drivebay_code_normalise('DBAY-0123-4567-89AB-CDEF') !== null],
    ],
];
file_put_contents($argv[1], json_encode($out, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) . "\n");
echo "wrote $argv[1]\n";
