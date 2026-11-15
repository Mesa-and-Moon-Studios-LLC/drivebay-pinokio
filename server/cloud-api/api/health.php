<?php
require dirname(__DIR__) . '/lib/bootstrap.php';

drivebay_json([
    'ok' => true,
    'service' => 'drivebay-cloud',
    'stores' => 'connection',
]);
