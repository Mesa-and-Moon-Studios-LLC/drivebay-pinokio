/**
 * Ed25519 public keys that may sign Drivebay licenses and activation receipts (hex, 32 bytes each).
 * The matching private key lives only on the license server, outside the web root, never in git.
 * To rotate: ship a build that lists both keys, move signing to the new key, then drop the old one.
 */
export const LICENSE_PUBLIC_KEYS = [
  "c9258c6b8c94fd949294d39bcd31cbc40b4a11219d762183c340465d83c35010",
];

/** Where activations, refreshes and deactivations go. */
export const LICENSE_API = "https://mesaandmoon.com/drivebay/api/license.php";

/** Where "Upgrade" buttons send people. Unlisted and noindex until Aaron launches. */
export const UPGRADE_URL = "https://mesaandmoon.com/drivebay/upgrade/";
