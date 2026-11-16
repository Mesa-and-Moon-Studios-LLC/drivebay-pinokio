/** Browser-safe copy and helpers for the locked machine list and remote access. */

export const CANNOT_RECOVER_MESSAGE =
  "Mesa and Moon cannot recover this. If you lose the passphrase, the passkey, and the recovery key, you will need to lock the list again and re-pair your machines. Your files stay on your devices and are not affected.";

export const REMOTE_ACCESS_BANNER_TITLE =
  "Unprotected port forward on — reachable from the internet, outside Tailscale";

export const REMOTE_ACCESS_BANNER =
  "While this port is open, DriveBay can be reached from the internet as plain HTTP. That traffic is not encrypted, so someone on the path could see it. Opening your files still takes a signed-in DriveBay account, a paired device, or an API token. Mesa and Moon cannot see your transfers or your devices.";

export function formatCountdown(ms) {
  const total = Math.max(0, Math.ceil(Number(ms) / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (n) => String(n).padStart(2, "0");
  if (hours > 0) return `${hours}:${pad(minutes)}:${pad(seconds)}`;
  return `${minutes}:${pad(seconds)}`;
}
