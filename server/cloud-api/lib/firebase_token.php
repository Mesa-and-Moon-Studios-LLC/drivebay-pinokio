<?php

/**
 * Verify a Firebase ID token with Google's published certificates.
 * Shared hosting does not need Composer.
 */

function drivebay_b64url($value) {
    $text = strtr($value, '-_', '+/');
    $pad = strlen($text) % 4;
    if ($pad) {
        $text .= str_repeat('=', 4 - $pad);
    }
    return base64_decode($text, true);
}

function drivebay_google_certs() {
    $cache = sys_get_temp_dir() . '/drivebay-firebase-certs.json';
    if (is_file($cache)) {
        $cached = json_decode(file_get_contents($cache), true);
        if (is_array($cached) && isset($cached['exp']) && $cached['exp'] > time() && isset($cached['certs'])) {
            return $cached['certs'];
        }
    }
    $url = 'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';
    $body = drivebay_http_get($url);
    if ($body === null) {
        return [];
    }
    $certs = json_decode($body, true);
    if (!is_array($certs)) {
        return [];
    }
    file_put_contents($cache, json_encode(['exp' => time() + 3600, 'certs' => $certs]));
    return $certs;
}

function drivebay_http_get($url) {
    if (function_exists('curl_init')) {
        $ch = curl_init($url);
        curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
        curl_setopt($ch, CURLOPT_TIMEOUT, 8);
        $body = curl_exec($ch);
        $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);
        if ($body !== false && $code >= 200 && $code < 300) {
            return $body;
        }
    }
    $body = @file_get_contents($url);
    return $body === false ? null : $body;
}

function drivebay_verify_firebase_jwt($jwt, $projectId) {
    $parts = explode('.', $jwt);
    if (count($parts) !== 3) {
        return null;
    }
    $header = json_decode(drivebay_b64url($parts[0]), true);
    $payload = json_decode(drivebay_b64url($parts[1]), true);
    $signature = drivebay_b64url($parts[2]);
    if (!is_array($header) || !is_array($payload) || $signature === false) {
        return null;
    }
    if (($header['alg'] ?? '') !== 'RS256' || empty($header['kid'])) {
        return null;
    }
    $certs = drivebay_google_certs();
    $pem = $certs[$header['kid']] ?? '';
    if (!$pem) {
        return null;
    }
    $ok = openssl_verify($parts[0] . '.' . $parts[1], $signature, $pem, OPENSSL_ALGO_SHA256);
    if ($ok !== 1) {
        return null;
    }
    $now = time();
    if (($payload['aud'] ?? '') !== $projectId) {
        return null;
    }
    if (($payload['iss'] ?? '') !== 'https://securetoken.google.com/' . $projectId) {
        return null;
    }
    if (!isset($payload['exp']) || $payload['exp'] < $now) {
        return null;
    }
    if (!isset($payload['iat']) || $payload['iat'] > $now + 300) {
        return null;
    }
    $sub = $payload['sub'] ?? '';
    if (!is_string($sub) || $sub === '') {
        return null;
    }
    return $payload;
}
