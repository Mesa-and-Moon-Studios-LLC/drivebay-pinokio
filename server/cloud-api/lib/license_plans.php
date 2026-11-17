<?php

/**
 * Public edition summary shown by api/license.php?action=plans and the upgrade page.
 * Prices are NOT here. They appear only if Aaron adds "prices" to config.json at launch.
 */
function drivebay_license_plans($ctx) {
    $prices = isset($ctx['config']['prices']) && is_array($ctx['config']['prices']) ? $ctx['config']['prices'] : null;
    $checkout = isset($ctx['config']['checkout']) && is_array($ctx['config']['checkout']) ? $ctx['config']['checkout'] : [];
    return [
        'editions' => [
            ['id' => 'free', 'name' => 'Free', 'seats' => null, 'features' => ['Link all your own machines', 'Tailscale and LAN access', 'WebDAV mounts and the phone as a drive', 'Up to 3 shared folders for other people']],
            ['id' => 'pro', 'name' => 'Pro', 'seats' => 3, 'features' => ['Everything in Free', 'Remote access from a trusted device, with a timer', 'Read-only or read-and-write remote access', 'Public access over your own port forward', 'Up to 25 shared folders', 'Updates for one year, then keep what you have']],
            ['id' => 'elite', 'name' => 'Elite', 'seats' => 10, 'features' => ['Everything in Pro', 'Remote sessions up to 24 hours', 'Unlimited shared folders', 'Ten devices', 'Priority support', 'Updates for two years']],
            ['id' => 'enterprise', 'name' => 'Enterprise', 'seats' => null, 'features' => ['Self-hosted on your own servers', 'Offline license file for air-gapped networks', 'Seat count set by your agreement', 'Updates and bug fixes included for the term', 'One-time or yearly license']],
        ],
        'prices' => $prices,
        // Checkout links are handed out only when Aaron flips checkout.enabled on. Until then the page shows disabled buttons.
        'checkout' => [
            'provider' => isset($checkout['provider']) ? $checkout['provider'] : 'none',
            'enabled' => !empty($checkout['enabled']),
            'links' => (!empty($checkout['enabled']) && isset($checkout['links']) && is_array($checkout['links'])) ? $checkout['links'] : new stdClass(),
        ],
    ];
}
