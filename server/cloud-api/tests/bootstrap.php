<?php
// Test bootstrap: uses ext-sodium when present, otherwise paragonie/sodium_compat (set SODIUM_COMPAT_AUTOLOAD).
if (!function_exists('sodium_crypto_sign_detached')) {
    $compat = getenv('SODIUM_COMPAT_AUTOLOAD');
    if (!$compat || !is_file($compat)) {
        fwrite(STDERR, "ext-sodium is missing. Set SODIUM_COMPAT_AUTOLOAD to sodium_compat/autoload.php.\n");
        exit(2);
    }
    require $compat;
}
require_once dirname(__DIR__) . '/lib/bootstrap.php';
require_once dirname(__DIR__) . '/lib/license_orders.php';
require_once dirname(__DIR__) . '/lib/license_plans.php';
require_once dirname(__DIR__) . '/lib/license_init.php';

$GLOBALS['t_pass'] = 0;
$GLOBALS['t_fail'] = 0;
function t_ok($cond, $name) {
    if ($cond) {
        $GLOBALS['t_pass']++;
        echo "  ok   $name\n";
    } else {
        $GLOBALS['t_fail']++;
        echo "  FAIL $name\n";
    }
}
function t_throws($fn, $code, $name) {
    try {
        $fn();
        t_ok(false, "$name (no error)");
    } catch (DrivebayLicenseError $e) {
        t_ok($e->code_name === $code, "$name -> $code" . ($e->code_name === $code ? '' : " (got {$e->code_name})"));
    }
}
function t_tmpdir() {
    $d = sys_get_temp_dir() . '/dbay-lic-' . bin2hex(random_bytes(4));
    mkdir($d, 0700, true);
    return $d;
}
function t_finish() {
    echo "\n{$GLOBALS['t_pass']} passed, {$GLOBALS['t_fail']} failed\n";
    exit($GLOBALS['t_fail'] > 0 ? 1 : 0);
}
