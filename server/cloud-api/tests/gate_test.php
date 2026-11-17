<?php
// Enterprise self-host license gate: unit tests plus a php -S run with the gate as auto_prepend_file.
require __DIR__ . '/bootstrap.php';
require_once dirname(__DIR__) . '/lib/license_gate.php';

const NOW = 1795000000;
$kp = sodium_crypto_sign_keypair();
$sk = sodium_crypto_sign_secretkey($kp);
$pk = sodium_crypto_sign_publickey($kp);
$other = sodium_crypto_sign_publickey(sodium_crypto_sign_keypair());
$dir = t_tmpdir();

function lic($sk, $over = []) {
    return drivebay_license_mint($over + ['edition' => 'enterprise', 'seats' => 2, 'issued' => NOW - 86400, 'expires' => NOW + 100 * 86400, 'updatesUntil' => null, 'offline' => true, 'label' => 'Acme'], $sk)[0];
}
function licfile($dir, $key, $name = 'license.dbaylicense') {
    $f = $dir . '/' . $name;
    file_put_contents($f, "-----BEGIN DRIVEBAY LICENSE-----\nLicensee: Acme\nKey: $key\n-----END DRIVEBAY LICENSE-----\n");
    return $f;
}

echo "evaluate\n";
$good = licfile($dir, lic($sk));
t_ok(drivebay_gate_evaluate($good, [$pk], NOW)['state'] === 'ok', 'valid enterprise file is ok');
t_ok(drivebay_gate_evaluate($dir . '/none', [$pk], NOW)['state'] === 'missing', 'no file is missing');
t_ok(drivebay_gate_evaluate($good, [$other], NOW)['state'] === 'invalid', 'wrong signer is invalid');
$tampered = licfile($dir, strtolower(lic($sk)) . 'A', 'bad.dbaylicense');
t_ok(drivebay_gate_evaluate($tampered, [$pk], NOW)['state'] === 'invalid', 'edited key is invalid');
$proKey = lic($sk, ['edition' => 'pro']);
t_ok(drivebay_gate_evaluate(licfile($dir, $proKey, 'pro.dbaylicense'), [$pk], NOW)['state'] === 'not_enterprise', 'a Pro key does not unlock self-hosting');
t_ok(drivebay_gate_evaluate($good, [$pk], NOW + 200 * 86400)['state'] === 'expired', 'term ended is expired');
$upd = licfile($dir, lic($sk, ['expires' => null, 'updatesUntil' => NOW + 10 * 86400]), 'upd.dbaylicense');
t_ok(drivebay_gate_evaluate($upd, [$pk], NOW + 500 * 86400, NOW + 500 * 86400)['state'] === 'updates_ended', 'build released after updates window is refused');
t_ok(drivebay_gate_evaluate($upd, [$pk], NOW + 500 * 86400, NOW)['state'] === 'ok', 'perpetual license keeps working on an older build');
t_ok(drivebay_gate_evaluate($upd, [$pk], NOW + 500 * 86400, null)['state'] === 'ok', 'no build timestamp means no updates check');

echo "decide\n";
$ok = drivebay_gate_evaluate($good, [$pk], NOW);
t_ok(drivebay_gate_decide($ok, ['m1'], ['m1']) === null, 'an already registered machine is always allowed');
t_ok(drivebay_gate_decide($ok, ['m1'], ['m2']) === null, 'a new machine inside the seat count is allowed');
$deny = drivebay_gate_decide($ok, ['m1', 'm2'], ['m3']);
t_ok($deny && $deny['code'] === 'seats_full' && $deny['status'] === 402, 'a new machine over the seat count is refused with 402');
t_ok(drivebay_gate_decide($ok, ['m1'], ['m2', 'm3']) !== null, 'a batch that would exceed the seats is refused');
t_ok(drivebay_gate_decide($ok, ['m1', 'm2'], ['m1', 'm2']) === null, 'refreshing every existing machine is fine at the limit');
$expired = drivebay_gate_evaluate($good, [$pk], NOW + 200 * 86400);
t_ok(drivebay_gate_decide($expired, ['m1'], ['m1']) === null, 'expired license still lets existing machines update');
t_ok(drivebay_gate_decide($expired, ['m1'], ['m2'])['code'] === 'expired', 'expired license refuses new machines');
$missing = drivebay_gate_evaluate($dir . '/none', [$pk], NOW);
t_ok(drivebay_gate_decide($missing, [], ['m1'])['code'] === 'missing', 'no license refuses new machines');
t_ok(drivebay_gate_incoming_ids(['envelopes' => [['machineId' => 'a'], ['machineId' => 'b']]]) === ['a', 'b'], 'batch machine ids are read');
t_ok(drivebay_gate_incoming_ids(['machineId' => 'x']) === ['x'], 'single machine id is read');
$st = drivebay_gate_status($ok, ['m1']);
t_ok($st['seats'] === 2 && $st['machinesRegistered'] === 1 && $st['licensee'] === 'Acme' && !isset($st['key']), 'status shows seats and use, not the key');

echo "php -S with the gate as auto_prepend_file\n";
$doc = $dir . '/www';
mkdir($doc . '/api', 0777, true);
file_put_contents($doc . '/api/machines.php', '<?php $b=json_decode(file_get_contents("php://input"),true); $p=new PDO("sqlite:" . getenv("DRIVEBAY_SQLITE_PATH")); $p->exec("CREATE TABLE IF NOT EXISTS drivebay_machines (uid TEXT, machine_id TEXT)"); if (!empty($b["machineId"])) { $p->prepare("INSERT INTO drivebay_machines VALUES (?,?)")->execute(["u", $b["machineId"]]); } echo json_encode(["ok"=>true]);');
file_put_contents($doc . '/api/enterprise-license.php', '<?php echo "{}";');
$compat = getenv('SODIUM_COMPAT_AUTOLOAD') ?: '';
$prepend = $dir . '/prepend.php';
file_put_contents($prepend, "<?php\nif (!function_exists('sodium_crypto_sign_detached')) { require " . var_export($compat, true) . "; }\nrequire " . var_export(dirname(__DIR__) . '/lib/license_gate.php', true) . ";\ndrivebay_gate_run([hex2bin('" . bin2hex($pk) . "')]);\n");
$sqlite = $dir . '/drivebay.sqlite';
$licPath = $dir . '/live.dbaylicense';
copy($good, $licPath);
$sock = stream_socket_server('tcp://127.0.0.1:0', $en, $es);
$port = (int) substr(strrchr(stream_socket_get_name($sock, false), ':'), 1);
fclose($sock);
$env = ['DRIVEBAY_LICENSE_FILE' => $licPath, 'DRIVEBAY_SQLITE_PATH' => $sqlite, 'DRIVEBAY_BUILD_TS_FILE' => $dir . '/none', 'PATH' => getenv('PATH')];
$proc = proc_open([PHP_BINARY, '-d', 'auto_prepend_file=' . $prepend, '-S', "127.0.0.1:$port", '-t', $doc], [1 => ['file', '/dev/null', 'w'], 2 => ['file', '/dev/null', 'w']], $pipes, $dir, $env);
$base = "http://127.0.0.1:$port";
for ($i = 0; $i < 60; $i++) {
    if (@file_get_contents($base . '/api/enterprise-license.php')) {
        break;
    }
    usleep(100000);
}
function post($url, $body) {
    $ctx = stream_context_create(['http' => ['method' => 'POST', 'header' => "Content-Type: application/json\r\n", 'content' => json_encode($body), 'ignore_errors' => true]]);
    $out = file_get_contents($url, false, $ctx);
    preg_match('/ (\d{3})/', $http_response_header[0], $m);
    return [(int) $m[1], json_decode($out, true)];
}
[$c1] = post($base . '/api/machines.php', ['machineId' => 'machine-0001']);
[$c2] = post($base . '/api/machines.php', ['machineId' => 'machine-0002']);
[$c3, $b3] = post($base . '/api/machines.php', ['machineId' => 'machine-0003']);
[$c4] = post($base . '/api/machines.php', ['machineId' => 'machine-0001']);
t_ok($c1 === 200 && $c2 === 200, 'two machines register under a 2-seat license');
t_ok($c3 === 402 && ($b3['code'] ?? '') === 'seats_full', 'the third machine gets 402 seats_full');
t_ok($c4 === 200, 'an existing machine can still check in at the limit');
$status = json_decode(file_get_contents($base . '/api/enterprise-license.php'), true);
t_ok(($status['seats'] ?? 0) === 2 && ($status['machinesRegistered'] ?? 0) === 2 && ($status['ok'] ?? false) === true, 'enterprise-license.php reports seats in use');
unlink($licPath);
[$c5, $b5] = post($base . '/api/machines.php', ['machineId' => 'machine-0009']);
[$c6] = post($base . '/api/machines.php', ['machineId' => 'machine-0002']);
t_ok($c5 === 402 && ($b5['code'] ?? '') === 'missing' && $c6 === 200, 'removing the license file stops new machines but never existing ones');
proc_terminate($proc);
proc_close($proc);
t_finish();
