/**
 * Loopback addresses for the PC that runs Drivebay.
 * LAN and Tailscale addresses are not the host.
 *
 * @param {string | null | undefined} address
 */
export function isLoopbackAddress(address) {
  if (!address) return false;
  let host = String(address).trim().toLowerCase();
  if (!host) return false;
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    host = end === -1 ? host.slice(1) : host.slice(1, end);
  }
  const zone = host.indexOf("%");
  if (zone !== -1) host = host.slice(0, zone);
  if (host.startsWith("::ffff:")) host = host.slice("::ffff:".length);
  if (host === "::1" || host === "localhost") return true;
  const parts = host.split(".");
  if (parts.length !== 4) return false;
  const nums = parts.map((part) => (/^\d+$/.test(part) ? Number(part) : NaN));
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  return nums[0] === 127;
}
