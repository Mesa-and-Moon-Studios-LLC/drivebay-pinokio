<?php

function drivebay_wrap_kinds() {
    return ['passphrase', 'passkey', 'recovery'];
}

function drivebay_sanitize_wrap($input) {
    if (!is_array($input)) {
        return null;
    }
    $allowed = ['wrapId', 'kind', 'alg', 'salt', 'nonce', 'wrappedDek', 'params', 'credentialId'];
    foreach (array_keys($input) as $key) {
        if (!in_array($key, $allowed, true)) {
            return null;
        }
    }
    $wrapId = isset($input['wrapId']) ? trim((string) $input['wrapId']) : '';
    if (!preg_match('/^[A-Za-z0-9_-]{8,64}$/', $wrapId)) {
        return null;
    }
    $kind = (string) ($input['kind'] ?? '');
    if (!in_array($kind, drivebay_wrap_kinds(), true)) {
        return null;
    }
    $alg = trim((string) ($input['alg'] ?? ''));
    if ($alg === '' || strlen($alg) > 64) {
        return null;
    }
    $wrapped = trim((string) ($input['wrappedDek'] ?? ''));
    $nonce = trim((string) ($input['nonce'] ?? ''));
    if (strlen($wrapped) < 16 || strlen($wrapped) > 8192 || strlen($nonce) < 8 || strlen($nonce) > 64) {
        return null;
    }
    $params = $input['params'] ?? new stdClass();
    if (is_array($params) || $params instanceof stdClass) {
        $encoded = json_encode($params);
    } else {
        return null;
    }
    if ($encoded === false || strlen($encoded) > 2048) {
        return null;
    }
    $credentialId = trim((string) ($input['credentialId'] ?? ''));
    if (strlen($credentialId) > 512) {
        return null;
    }
    return [
        'wrapId' => $wrapId,
        'kind' => $kind,
        'alg' => $alg,
        'salt' => substr(trim((string) ($input['salt'] ?? '')), 0, 128),
        'nonce' => $nonce,
        'wrappedDek' => $wrapped,
        'params' => $encoded,
        'credentialId' => $credentialId,
    ];
}

function drivebay_wrap_out($row) {
    $params = json_decode($row['params'], true);
    if (!is_array($params)) {
        $params = new stdClass();
    }
    return [
        'wrapId' => $row['wrap_id'],
        'kind' => $row['kind'],
        'alg' => $row['alg'],
        'salt' => $row['salt'],
        'nonce' => $row['nonce'],
        'wrappedDek' => $row['wrapped_dek'],
        'params' => $params,
        'credentialId' => $row['credential_id'],
    ];
}

function drivebay_list_wraps(PDO $pdo, $uid) {
    $stmt = $pdo->prepare(
        'SELECT wrap_id, kind, alg, wrapped_dek, nonce, salt, params, credential_id
         FROM drivebay_key_wraps WHERE uid = ? ORDER BY kind, wrap_id'
    );
    $stmt->execute([$uid]);
    $out = [];
    foreach ($stmt->fetchAll() as $row) {
        $out[] = drivebay_wrap_out($row);
    }
    return $out;
}

function drivebay_replace_wraps(PDO $pdo, $uid, $wraps) {
    $clean = [];
    foreach ($wraps as $item) {
        $one = drivebay_sanitize_wrap($item);
        if ($one === null) {
            return false;
        }
        $clean[] = $one;
    }
    $kinds = [];
    foreach ($clean as $one) {
        $kinds[$one['kind']] = true;
    }
    if (empty($kinds['passphrase']) && empty($kinds['recovery'])) {
        return false;
    }
    $pdo->beginTransaction();
    try {
        $del = $pdo->prepare('DELETE FROM drivebay_key_wraps WHERE uid = ?');
        $del->execute([$uid]);
        $ins = $pdo->prepare(
            'INSERT INTO drivebay_key_wraps
              (uid, wrap_id, kind, alg, wrapped_dek, nonce, salt, params, credential_id, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        );
        $now = gmdate('Y-m-d H:i:s');
        foreach ($clean as $one) {
            $ins->execute([
                $uid,
                $one['wrapId'],
                $one['kind'],
                $one['alg'],
                $one['wrappedDek'],
                $one['nonce'],
                $one['salt'],
                $one['params'],
                $one['credentialId'],
                $now,
            ]);
        }
        $pdo->commit();
        return true;
    } catch (Exception $err) {
        $pdo->rollBack();
        drivebay_log('Vault wrap write failed.');
        return false;
    }
}

function drivebay_vault_locked(PDO $pdo, $uid) {
    $stmt = $pdo->prepare('SELECT COUNT(*) AS n FROM drivebay_key_wraps WHERE uid = ?');
    $stmt->execute([$uid]);
    $row = $stmt->fetch();
    return $row && (int) $row['n'] > 0;
}
