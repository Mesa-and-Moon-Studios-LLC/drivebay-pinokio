<?php
// Runs before every cloud API script (php.ini auto_prepend_file). See lib/license_gate.php for the rules.
require_once '/var/www/html/lib/license_gate.php';
drivebay_gate_run();
