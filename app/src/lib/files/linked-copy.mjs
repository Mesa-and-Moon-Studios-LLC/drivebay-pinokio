/** Browser-safe copy and helpers for the locked machine list and remote access. */

export const CANNOT_RECOVER_MESSAGE =
  "Mesa and Moon cannot recover this. If you lose the passphrase, the passkey, and the recovery key, you will need to lock the list again and re-pair your machines. Your files stay on your devices and are not affected.";

export const REMOTE_ACCESS_BANNER =
  "Remote access is on. This computer's regular internet port is open. Anyone who can reach that port can try to connect. Your files stay on this machine and do not pass through Mesa and Moon servers.";

export function formatCountdown(ms) {
  const total = Math.max(0, Math.ceil(Number(ms) / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (n) => String(n).padStart(2, "0");
  if (hours > 0) return `${hours}:${pad(minutes)}:${pad(seconds)}`;
  return `${minutes}:${pad(seconds)}`;
}
