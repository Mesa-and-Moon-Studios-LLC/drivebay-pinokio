<?php

/**
 * Allowed cloud fields. Keep plaintext keys in sync with CLOUD_KEYS in
 * app/src/lib/files/linked-machines.mjs. Encrypted envelopes use ENVELOPE_KEYS.
 */
function drivebay_cloud_keys() {
    return [
        'machineId',
        'displayName',
        'type',
        'tailscaleHost',
        'lanAddress',
        'port',
        'publicKey',
        'lastSeen',
        'hidden',
        'directInternet',
        'publicHost',
    ];
}

function drivebay_envelope_keys() {
    return ['machineId', 'lastSeen', 'ciphertext', 'nonce', 'envelopeVersion'];
}

function drivebay_clean_host($value) {
    $host = trim(str_replace(["\r", "\n", "\0"], '', (string) $value));
    if ($host === '' || preg_match('/[\s\/\\\\]/', $host) || strlen($host) > 253) {
        return '';
    }
    return $host;
}

function drivebay_sanitize_machine($input) {
    if (!is_array($input)) {
        return null;
    }
    foreach (array_keys($input) as $key) {
        if (!in_array($key, drivebay_cloud_keys(), true)) {
            return null;
        }
    }
    $machineId = isset($input['machineId']) ? trim((string) $input['machineId']) : '';
    if (!preg_match('/^[A-Za-z0-9_-]{8,64}$/', $machineId)) {
        return null;
    }
    $displayName = trim(str_replace(["\r", "\n", "\0"], ' ', (string) ($input['displayName'] ?? '')));
    if ($displayName === '' || strlen($displayName) > 80) {
        return null;
    }
    $type = (string) ($input['type'] ?? '');
    if (!in_array($type, ['pc', 'mac', 'linux', 'phone'], true)) {
        return null;
    }
    $port = isset($input['port']) ? (int) $input['port'] : 0;
    if ($port < 1 || $port > 65535) {
        return null;
    }
    $publicKey = trim((string) ($input['publicKey'] ?? ''));
    if (strlen($publicKey) < 16 || strlen($publicKey) > 4096) {
        return null;
    }
    $seen = strtotime((string) ($input['lastSeen'] ?? ''));
    if ($seen === false) {
        return null;
    }
    if ($seen > time() + 300) {
        $seen = time();
    }
    $direct = !empty($input['directInternet']);
    return [
        'envelopeVersion' => 1,
        'machineId' => $machineId,
        'displayName' => $displayName,
        'type' => $type,
        'tailscaleHost' => drivebay_clean_host($input['tailscaleHost'] ?? ''),
        'lanAddress' => drivebay_clean_host($input['lanAddress'] ?? ''),
        'port' => $port,
        'publicKey' => $publicKey,
        'lastSeen' => gmdate('Y-m-d H:i:s', $seen),
        'hidden' => !empty($input['hidden']) ? 1 : 0,
        'directInternet' => $direct ? 1 : 0,
        'publicHost' => $direct ? drivebay_clean_host($input['publicHost'] ?? '') : '',
        'ciphertext' => '',
        'nonce' => '',
    ];
}

function drivebay_sanitize_envelope($input) {
    if (!is_array($input)) {
        return null;
    }
    foreach (array_keys($input) as $key) {
        if (!in_array($key, drivebay_envelope_keys(), true)) {
            return null;
        }
    }
    $machineId = isset($input['machineId']) ? trim((string) $input['machineId']) : '';
    if (!preg_match('/^[A-Za-z0-9_-]{8,64}$/', $machineId)) {
        return null;
    }
    $seen = strtotime((string) ($input['lastSeen'] ?? ''));
    if ($seen === false) {
        return null;
    }
    if ($seen > time() + 300) {
        $seen = time();
    }
    $ciphertext = trim((string) ($input['ciphertext'] ?? ''));
    $nonce = trim((string) ($input['nonce'] ?? ''));
    $version = isset($input['envelopeVersion']) ? (int) $input['envelopeVersion'] : 0;
    if ($version !== 2 || strlen($ciphertext) < 24 || strlen($ciphertext) > 32768 || strlen($nonce) < 8 || strlen($nonce) > 64) {
        return null;
    }
    return [
        'envelopeVersion' => 2,
        'machineId' => $machineId,
        'displayName' => '',
        'type' => 'pc',
        'tailscaleHost' => '',
        'lanAddress' => '',
        'port' => 0,
        'publicKey' => '',
        'lastSeen' => gmdate('Y-m-d H:i:s', $seen),
        'hidden' => 0,
        'directInternet' => 0,
        'publicHost' => '',
        'ciphertext' => $ciphertext,
        'nonce' => $nonce,
    ];
}

function drivebay_accept_machine($input, $vaultLocked) {
    if (is_array($input) && isset($input['envelopeVersion']) && (int) $input['envelopeVersion'] === 2) {
        return drivebay_sanitize_envelope($input);
    }
    if ($vaultLocked) {
        return null;
    }
    return drivebay_sanitize_machine($input);
}

function drivebay_row_out($row) {
    if ((int) ($row['envelope_version'] ?? 1) === 2 && trim((string) ($row['ciphertext'] ?? '')) !== '') {
        return [
            'machineId' => $row['machine_id'],
            'lastSeen' => gmdate('c', strtotime($row['last_seen'] . (strpos($row['last_seen'], 'Z') !== false || strpos($row['last_seen'], '+') !== false ? '' : ' UTC'))),
            'ciphertext' => $row['ciphertext'],
            'nonce' => $row['nonce'],
            'envelopeVersion' => 2,
        ];
    }
    return [
        'machineId' => $row['machine_id'],
        'displayName' => $row['display_name'],
        'type' => $row['machine_type'],
        'tailscaleHost' => $row['tailscale_host'],
        'lanAddress' => $row['lan_address'],
        'port' => (int) $row['port'],
        'publicKey' => $row['public_key'],
        'lastSeen' => gmdate('c', strtotime($row['last_seen'] . (strpos((string) $row['last_seen'], 'Z') !== false || strpos((string) $row['last_seen'], '+') !== false ? '' : ' UTC'))),
        'hidden' => (int) $row['hidden'] === 1,
        'directInternet' => (int) $row['direct_internet'] === 1,
        'publicHost' => (int) $row['direct_internet'] === 1 ? $row['public_host'] : '',
        'envelopeVersion' => 1,
        'legacy' => true,
    ];
}

function drivebay_list_machines(PDO $pdo, $uid, $selfId) {
    $stmt = $pdo->prepare(
        'SELECT machine_id, display_name, machine_type, tailscale_host, lan_address, port, public_key, last_seen, hidden, direct_internet, public_host, envelope_version, ciphertext, nonce
         FROM drivebay_machines WHERE uid = ? ORDER BY display_name, machine_id'
    );
    $stmt->execute([$uid]);
    $out = [];
    foreach ($stmt->fetchAll() as $row) {
        $item = drivebay_row_out($row);
        if (!empty($item['legacy']) && !empty($row['hidden']) && (int) $row['hidden'] === 1 && $row['machine_id'] !== $selfId) {
            continue;
        }
        $out[] = $item;
    }
    return $out;
}

function drivebay_upsert_machine(PDO $pdo, $uid, $machine) {
    // SQLite uses ON CONFLICT; MySQL uses ON DUPLICATE KEY. Prepare only the statement for the active driver.
    $driver = $pdo->getAttribute(PDO::ATTR_DRIVER_NAME);
    $values = [
        $uid,
        $machine['machineId'],
        $machine['displayName'],
        $machine['type'],
        $machine['tailscaleHost'],
        $machine['lanAddress'],
        $machine['port'],
        $machine['publicKey'],
        $machine['lastSeen'],
        $machine['hidden'],
        $machine['directInternet'],
        $machine['publicHost'],
        $machine['envelopeVersion'],
        $machine['ciphertext'],
        $machine['nonce'],
    ];
    if ($driver === 'sqlite') {
        $stmt = $pdo->prepare(
            'INSERT INTO drivebay_machines
              (uid, machine_id, display_name, machine_type, tailscale_host, lan_address, port, public_key, last_seen, hidden, direct_internet, public_host, envelope_version, ciphertext, nonce)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(uid, machine_id) DO UPDATE SET
              display_name = excluded.display_name,
              machine_type = excluded.machine_type,
              tailscale_host = excluded.tailscale_host,
              lan_address = excluded.lan_address,
              port = excluded.port,
              public_key = excluded.public_key,
              last_seen = excluded.last_seen,
              hidden = excluded.hidden,
              direct_internet = excluded.direct_internet,
              public_host = excluded.public_host,
              envelope_version = excluded.envelope_version,
              ciphertext = excluded.ciphertext,
              nonce = excluded.nonce'
        );
    }
    if ($driver !== 'sqlite') {
        $stmt = $pdo->prepare(
            'INSERT INTO drivebay_machines
              (uid, machine_id, display_name, machine_type, tailscale_host, lan_address, port, public_key, last_seen, hidden, direct_internet, public_host, envelope_version, ciphertext, nonce)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
              display_name = VALUES(display_name),
              machine_type = VALUES(machine_type),
              tailscale_host = VALUES(tailscale_host),
              lan_address = VALUES(lan_address),
              port = VALUES(port),
              public_key = VALUES(public_key),
              last_seen = VALUES(last_seen),
              hidden = VALUES(hidden),
              direct_internet = VALUES(direct_internet),
              public_host = VALUES(public_host),
              envelope_version = VALUES(envelope_version),
              ciphertext = VALUES(ciphertext),
              nonce = VALUES(nonce)'
        );
    }
    $stmt->execute($values);
}

function drivebay_delete_machine(PDO $pdo, $uid, $machineId) {
    $stmt = $pdo->prepare('DELETE FROM drivebay_machines WHERE uid = ? AND machine_id = ?');
    $stmt->execute([$uid, $machineId]);
}
