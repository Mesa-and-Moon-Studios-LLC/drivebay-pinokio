<?php

function drivebay_config() {
    static $config = null;
    if ($config !== null) {
        return $config;
    }
    $path = dirname(__DIR__) . '/config.php';
    if (!is_file($path)) {
        drivebay_fail(500, 'Cloud API is not configured.');
    }
    $loaded = require $path;
    if (!is_array($loaded) || empty($loaded['firebase_project_id']) || empty($loaded['db_name'])) {
        drivebay_fail(500, 'Cloud API config is incomplete.');
    }
    $config = $loaded;
    return $config;
}

function drivebay_fail($status, $message) {
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    echo json_encode(['error' => $message]);
    exit;
}

function drivebay_json($value, $status = 200) {
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    echo json_encode($value);
    exit;
}

function drivebay_pdo() {
    $config = drivebay_config();
    $dsn = 'mysql:host=' . $config['db_host'] . ';dbname=' . $config['db_name'] . ';charset=utf8mb4';
    return new PDO($dsn, $config['db_user'], $config['db_pass'], [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        PDO::ATTR_EMULATE_PREPARES => false,
    ]);
}

function drivebay_bearer() {
    $header = isset($_SERVER['HTTP_AUTHORIZATION']) ? $_SERVER['HTTP_AUTHORIZATION'] : '';
    if (!preg_match('/^Bearer\s+(\S+)$/i', $header, $match)) {
        drivebay_fail(401, 'Sign in required.');
    }
    require_once __DIR__ . '/firebase_token.php';
    $user = drivebay_verify_firebase_jwt($match[1], drivebay_config()['firebase_project_id']);
    if ($user === null) {
        drivebay_fail(401, 'Sign in required.');
    }
    return $user;
}

function drivebay_body() {
    $raw = file_get_contents('php://input');
    if ($raw === false || $raw === '') {
        return [];
    }
    $parsed = json_decode($raw, true);
    if (!is_array($parsed)) {
        drivebay_fail(400, 'Expected JSON.');
    }
    return $parsed;
}
