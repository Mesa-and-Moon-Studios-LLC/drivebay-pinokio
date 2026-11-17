<?php
/**
 * One-time setup on a host with PHP CLI (Enterprise self-host, or a host you can shell into):
 *   php tools/license-init.php [license-dir] [admin-token-sha256]
 * Prints the public key (hex). The private key stays in <license-dir>/signing.key (mode 0600).
 * Enterprise self-hosts do not need a signing key: they only verify Aaron's licenses, using public.key.
 */
require dirname(__DIR__) . '/lib/license_init.php';
$dir = isset($argv[1]) ? $argv[1] : drivebay_license_dir();
$hash = isset($argv[2]) ? $argv[2] : '';
$out = drivebay_license_init($dir, $hash);
echo 'public key: ' . $out['publicKey'] . "\n";
echo $out['createdKey'] ? "created a new signing key in $dir/signing.key\n" : "kept the existing signing key\n";
