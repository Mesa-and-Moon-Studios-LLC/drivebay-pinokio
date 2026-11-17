<?php

/**
 * Drivebay license keys and activation receipts (format v1).
 *
 * A license key is `DBAY-` plus Crockford base32 of payload || Ed25519 signature, in groups of five.
 * The payload is binary:
 *   0      version (1)
 *   1      edition (1 pro, 2 elite, 3 enterprise)
 *   2-3    seats (uint16, big endian)
 *   4      flags (bit0 = offline ok: no activation needed, for air-gapped Enterprise)
 *   5-6    issued day (uint16, days since 2026-01-01 UTC)
 *   7-8    expires day (0 = perpetual)
 *   9-10   updates-until day (0xFFFF = lifetime updates)
 *   11-18  license id (8 random bytes)
 *   19     label length n (0..48)
 *   20..   label (UTF-8)
 * The signature covers "DRIVEBAY-LICENSE-v1\0" || payload.
 *
 * A short purchase code is `DBAY-XXXX-XXXX-XXXX-XXXX` (15 random Crockford characters plus one check
 * character). It is not a license: the server looks it up (hash only) and mints the real key.
 *
 * An activation receipt binds a license to one machine for a limited time:
 *   version(1) | license id(8) | sha256(machineId)[0..8] | issuedAt uint32 | validUntil uint32, signed
 * with "DRIVEBAY-RECEIPT-v1\0". Text form: `DBAR1.<base64url(payload||signature)>`.
 */

const DRIVEBAY_LICENSE_EPOCH = 1767225600; // 2026-01-01T00:00:00Z
const DRIVEBAY_LICENSE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const DRIVEBAY_LICENSE_EDITIONS = [1 => 'pro', 2 => 'elite', 3 => 'enterprise'];
const DRIVEBAY_LIFETIME_UPDATES = 0xFFFF;

function drivebay_b32_encode($bytes) {
    $bits = '';
    $len = strlen($bytes);
    for ($i = 0; $i < $len; $i++) {
        $bits .= str_pad(decbin(ord($bytes[$i])), 8, '0', STR_PAD_LEFT);
    }
    $out = '';
    for ($i = 0; $i < strlen($bits); $i += 5) {
        $chunk = substr($bits, $i, 5);
        $chunk = str_pad($chunk, 5, '0', STR_PAD_RIGHT);
        $out .= DRIVEBAY_LICENSE_ALPHABET[bindec($chunk)];
    }
    return $out;
}

/** Tolerant decode: case-insensitive, I/L read as 1, O reads as 0, separators ignored. Returns null on bad input. */
function drivebay_b32_decode($text) {
    $text = strtoupper($text);
    $text = preg_replace('/[\s\-]+/', '', $text);
    $text = strtr($text, ['I' => '1', 'L' => '1', 'O' => '0']);
    $bits = '';
    $len = strlen($text);
    for ($i = 0; $i < $len; $i++) {
        $pos = strpos(DRIVEBAY_LICENSE_ALPHABET, $text[$i]);
        if ($pos === false) {
            return null;
        }
        $bits .= str_pad(decbin($pos), 5, '0', STR_PAD_LEFT);
    }
    $whole = intdiv(strlen($bits), 8) * 8;
    // Trailing pad bits must be zero.
    if ($whole < strlen($bits) && trim(substr($bits, $whole), '0') !== '') {
        return null;
    }
    $out = '';
    for ($i = 0; $i < $whole; $i += 8) {
        $out .= chr(bindec(substr($bits, $i, 8)));
    }
    return $out;
}

function drivebay_lic_b64url_decode($value) {
    $text = strtr((string) $value, '-_', '+/');
    $pad = strlen($text) % 4;
    if ($pad) {
        $text .= str_repeat('=', 4 - $pad);
    }
    return base64_decode($text, true);
}

function drivebay_group($text, $size) {
    return implode('-', str_split($text, $size));
}

function drivebay_day_from_ts($ts) {
    return (int) floor(($ts - DRIVEBAY_LICENSE_EPOCH) / 86400);
}

function drivebay_ts_from_day($day) {
    return DRIVEBAY_LICENSE_EPOCH + $day * 86400;
}

function drivebay_license_sign($message, $secretKey, $domain) {
    return sodium_crypto_sign_detached($domain . $message, $secretKey);
}

function drivebay_license_verify_sig($message, $signature, $publicKey, $domain) {
    if (strlen($signature) !== 64 || strlen($publicKey) !== 32) {
        return false;
    }
    try {
        return sodium_crypto_sign_verify_detached($signature, $domain . $message, $publicKey);
    } catch (Throwable $err) {
        return false;
    }
}

const DRIVEBAY_LICENSE_DOMAIN = "DRIVEBAY-LICENSE-v1\0";
const DRIVEBAY_RECEIPT_DOMAIN = "DRIVEBAY-RECEIPT-v1\0";

/**
 * @param array $f edition(pro|elite|enterprise), seats, issued(ts), expires(ts|null), updatesUntil(ts|null=lifetime),
 *                 offline(bool), id(hex16, optional), label(optional)
 * @return array [key string, normalized license array]
 */
function drivebay_license_mint($f, $secretKey) {
    $edition = array_search($f['edition'], DRIVEBAY_LICENSE_EDITIONS, true);
    if ($edition === false) {
        throw new InvalidArgumentException('Unknown edition.');
    }
    $seats = (int) $f['seats'];
    if ($seats < 1 || $seats > 65535) {
        throw new InvalidArgumentException('Seats must be 1 to 65535.');
    }
    $issuedDay = drivebay_day_from_ts((int) $f['issued']);
    $expires = isset($f['expires']) ? $f['expires'] : null;
    $expiresDay = $expires === null ? 0 : drivebay_day_from_ts((int) $expires);
    $updates = isset($f['updatesUntil']) ? $f['updatesUntil'] : null;
    $updatesDay = $updates === null ? DRIVEBAY_LIFETIME_UPDATES : drivebay_day_from_ts((int) $updates);
    if ($issuedDay < 1 || $issuedDay > 0xFFFE || $expiresDay < 0 || $expiresDay > 0xFFFE || $updatesDay < 0 || $updatesDay > 0xFFFF) {
        throw new InvalidArgumentException('A date is out of range.');
    }
    if ($expires !== null && $expiresDay < $issuedDay) {
        throw new InvalidArgumentException('Expiry is before the issue date.');
    }
    $id = isset($f['id']) && $f['id'] !== '' ? hex2bin($f['id']) : random_bytes(8);
    if ($id === false || strlen($id) !== 8) {
        throw new InvalidArgumentException('License id must be 16 hex characters.');
    }
    $label = isset($f['label']) ? (string) $f['label'] : '';
    if (strlen($label) > 48) {
        throw new InvalidArgumentException('Label is longer than 48 bytes.');
    }
    $flags = !empty($f['offline']) ? 1 : 0;
    $payload = chr(1) . chr($edition) . pack('n', $seats) . chr($flags)
        . pack('n', $issuedDay) . pack('n', $expiresDay) . pack('n', $updatesDay)
        . $id . chr(strlen($label)) . $label;
    $sig = drivebay_license_sign($payload, $secretKey, DRIVEBAY_LICENSE_DOMAIN);
    $key = 'DBAY-' . drivebay_group(drivebay_b32_encode($payload . $sig), 5);
    return [$key, drivebay_license_parse_payload($payload)];
}

function drivebay_license_parse_payload($payload) {
    if (strlen($payload) < 20 || ord($payload[0]) !== 1) {
        return null;
    }
    $edition = ord($payload[1]);
    if (!isset(DRIVEBAY_LICENSE_EDITIONS[$edition])) {
        return null;
    }
    $labelLen = ord($payload[19]);
    if ($labelLen > 48 || strlen($payload) !== 20 + $labelLen) {
        return null;
    }
    $u = function ($o) use ($payload) {
        return unpack('n', substr($payload, $o, 2))[1];
    };
    $expiresDay = $u(7);
    $updatesDay = $u(9);
    return [
        'edition' => DRIVEBAY_LICENSE_EDITIONS[$edition],
        'seats' => $u(2),
        'offline' => (ord($payload[4]) & 1) === 1,
        'issued' => drivebay_ts_from_day($u(5)),
        'expires' => $expiresDay === 0 ? null : drivebay_ts_from_day($expiresDay),
        'updatesUntil' => $updatesDay === DRIVEBAY_LIFETIME_UPDATES ? null : drivebay_ts_from_day($updatesDay),
        'id' => bin2hex(substr($payload, 11, 8)),
        'label' => substr($payload, 20, $labelLen),
    ];
}

/**
 * Verify a license key string. Does not check expiry; callers apply drivebay_license_state().
 * @param string|array $publicKeys one raw 32-byte key or a list of them
 * @return array ['ok'=>bool, 'error'=>string, 'license'=>array|null]
 */
function drivebay_license_verify($keyText, $publicKeys) {
    $text = trim((string) $keyText);
    if (stripos($text, 'DBAY') !== 0) {
        return ['ok' => false, 'error' => 'format', 'license' => null];
    }
    $raw = drivebay_b32_decode(substr($text, 4));
    if ($raw === null || strlen($raw) < 20 + 64) {
        return ['ok' => false, 'error' => 'format', 'license' => null];
    }
    $payload = substr($raw, 0, -64);
    $sig = substr($raw, -64);
    $keys = is_array($publicKeys) ? $publicKeys : [$publicKeys];
    $valid = false;
    foreach ($keys as $pk) {
        if (drivebay_license_verify_sig($payload, $sig, $pk, DRIVEBAY_LICENSE_DOMAIN)) {
            $valid = true;
            break;
        }
    }
    if (!$valid) {
        return ['ok' => false, 'error' => 'signature', 'license' => null];
    }
    $license = drivebay_license_parse_payload($payload);
    if ($license === null) {
        return ['ok' => false, 'error' => 'format', 'license' => null];
    }
    return ['ok' => true, 'error' => '', 'license' => $license];
}

/** active | expired | updates_ended (for a given app build time) */
function drivebay_license_state($license, $now, $buildTs = null) {
    if ($license['expires'] !== null && $now >= $license['expires'] + 86400) {
        return 'expired';
    }
    if ($buildTs !== null && $license['updatesUntil'] !== null && $buildTs > $license['updatesUntil'] + 86400) {
        return 'updates_ended';
    }
    return 'active';
}

function drivebay_machine_hash($machineId) {
    return substr(hash('sha256', (string) $machineId, true), 0, 8);
}

function drivebay_receipt_mint($licenseIdHex, $machineId, $issuedAt, $validUntil, $secretKey) {
    $payload = chr(1) . hex2bin($licenseIdHex) . drivebay_machine_hash($machineId) . pack('N', $issuedAt) . pack('N', $validUntil);
    $sig = drivebay_license_sign($payload, $secretKey, DRIVEBAY_RECEIPT_DOMAIN);
    return 'DBAR1.' . rtrim(strtr(base64_encode($payload . $sig), '+/', '-_'), '=');
}

function drivebay_receipt_verify($text, $machineId, $publicKeys, $now) {
    if (strpos((string) $text, 'DBAR1.') !== 0) {
        return ['ok' => false, 'error' => 'format'];
    }
    $raw = drivebay_lic_b64url_decode(substr($text, 6));
    if ($raw === false || $raw === null || strlen($raw) !== 25 + 64) {
        return ['ok' => false, 'error' => 'format'];
    }
    $payload = substr($raw, 0, 25);
    $sig = substr($raw, 25);
    $keys = is_array($publicKeys) ? $publicKeys : [$publicKeys];
    $valid = false;
    foreach ($keys as $pk) {
        if (drivebay_license_verify_sig($payload, $sig, $pk, DRIVEBAY_RECEIPT_DOMAIN)) {
            $valid = true;
            break;
        }
    }
    if (!$valid || ord($payload[0]) !== 1) {
        return ['ok' => false, 'error' => 'signature'];
    }
    if (substr($payload, 9, 8) !== drivebay_machine_hash($machineId)) {
        return ['ok' => false, 'error' => 'machine'];
    }
    $issued = unpack('N', substr($payload, 17, 4))[1];
    $until = unpack('N', substr($payload, 21, 4))[1];
    if ($now >= $until) {
        return ['ok' => false, 'error' => 'receipt_expired', 'licenseId' => bin2hex(substr($payload, 1, 8))];
    }
    return ['ok' => true, 'error' => '', 'licenseId' => bin2hex(substr($payload, 1, 8)), 'issuedAt' => $issued, 'validUntil' => $until];
}

/** Short purchase code: 15 random Crockford chars + 1 check char, shown as DBAY-XXXX-XXXX-XXXX-XXXX. */
function drivebay_code_check_char($fifteen) {
    $sum = 0;
    for ($i = 0; $i < 15; $i++) {
        $sum += (strpos(DRIVEBAY_LICENSE_ALPHABET, $fifteen[$i]) + 1) * ($i + 3);
    }
    return DRIVEBAY_LICENSE_ALPHABET[$sum % 32];
}

function drivebay_code_generate() {
    $chars = '';
    for ($i = 0; $i < 15; $i++) {
        $chars .= DRIVEBAY_LICENSE_ALPHABET[random_int(0, 31)];
    }
    $chars .= drivebay_code_check_char($chars);
    return 'DBAY-' . drivebay_group($chars, 4);
}

/** Normalised 16-char form of a purchase code, or null if it is not one (wrong length, bad char, bad check). */
function drivebay_code_normalise($text) {
    $text = strtoupper(trim((string) $text));
    if (strpos($text, 'DBAY') !== 0) {
        return null;
    }
    $rest = strtr(preg_replace('/[\s\-]+/', '', substr($text, 4)), ['I' => '1', 'L' => '1', 'O' => '0']);
    if (strlen($rest) !== 16 || strspn($rest, DRIVEBAY_LICENSE_ALPHABET) !== 16) {
        return null;
    }
    return drivebay_code_check_char(substr($rest, 0, 15)) === $rest[15] ? $rest : null;
}

function drivebay_code_hash($normalised) {
    return hash('sha256', 'drivebay-code-v1:' . $normalised);
}
