<?php
// Answered by the license gate (it runs first and exits). Reaching this line means the gate is not active.
header('Content-Type: application/json; charset=utf-8');
http_response_code(503);
echo json_encode(['ok' => false, 'state' => 'gate_inactive', 'message' => 'The license gate is not loaded.']);
