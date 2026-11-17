<?php

require_once __DIR__ . '/license_store.php';

/**
 * Create the license folder, the Ed25519 signing key (only if missing) and a starter config.json.
 * Returns the public key hex. The private key is never returned or printed.
 */
function drivebay_license_init($dir, $adminTokenSha256 = '') {
    if (!is_dir($dir) && !mkdir($dir, 0700, true)) {
        throw new RuntimeException('Cannot create ' . $dir);
    }
    @chmod($dir, 0700);
    $keyFile = $dir . '/signing.key';
    $created = false;
    if (!is_file($keyFile)) {
        $kp = sodium_crypto_sign_keypair();
        file_put_contents($keyFile, bin2hex(sodium_crypto_sign_secretkey($kp)), LOCK_EX);
        @chmod($keyFile, 0600);
        $created = true;
    }
    $secret = hex2bin(trim((string) file_get_contents($keyFile)));
    $public = sodium_crypto_sign_publickey_from_secretkey($secret);
    file_put_contents($dir . '/public.key', bin2hex($public));
    @chmod($dir . '/public.key', 0644);
    // Deny web access if the folder ever ends up under the web root.
    file_put_contents($dir . '/.htaccess', "Require all denied\n");
    $config = drivebay_license_load_config($dir);
    if ($adminTokenSha256 !== '' && empty($config['admin_token_sha256'])) {
        $config['admin_token_sha256'] = $adminTokenSha256;
    }
    $config += [
        'providers' => new stdClass(),
        'products' => [
            'pro-1y' => ['name' => 'Pro', 'edition' => 'pro', 'seats' => 3, 'termMonths' => 0, 'updatesMonths' => 12, 'label' => ''],
            'elite-1y' => ['name' => 'Elite', 'edition' => 'elite', 'seats' => 10, 'termMonths' => 0, 'updatesMonths' => 24, 'label' => ''],
        ],
        'mail' => ['enabled' => false],
        'checkout' => ['provider' => 'none', 'enabled' => false],
    ];
    drivebay_license_save_config($dir, $config);
    return ['publicKey' => bin2hex($public), 'createdKey' => $created];
}
