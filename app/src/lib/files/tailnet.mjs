/**
 * Tailscale's tailnet ranges.
 * IPv4 is 100.64.0.0/10. IPv6 is fd7a:115c:a1e0::/48.
 * A LAN or public address is not a tailnet address.
 *
 * @param {string | null | undefined} address
 */
export function isTailnetAddress(address) {
  const host = normalizeHost(address);
  if (!host) return false;
  if (host.includes(":")) {
    const mapped = ipv4Mapped(host);
    if (mapped) return isTailnetIpv4(mapped);
    return isTailnetIpv6(host);
  }
  return isTailnetIpv4(host);
}

/**
 * @param {string | null | undefined} address
 */
function normalizeHost(address) {
  if (!address) return "";
  let host = String(address).trim().toLowerCase();
  if (!host) return "";
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    host = end === -1 ? host.slice(1) : host.slice(1, end);
  }
  const zone = host.indexOf("%");
  if (zone !== -1) host = host.slice(0, zone);
  return host;
}

/** @param {string} host */
function ipv4Mapped(host) {
  if (!host.startsWith("::ffff:")) return "";
  const rest = host.slice("::ffff:".length);
  return rest.includes(".") ? rest : "";
}

/** @param {string} host */
function isTailnetIpv4(host) {
  const parts = host.split(".");
  if (parts.length !== 4) return false;
  const nums = parts.map((part) => (/^\d+$/.test(part) ? Number(part) : NaN));
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  return nums[0] === 100 && nums[1] >= 64 && nums[1] <= 127;
}

/**
 * First 48 bits of fd7a:115c:a1e0::/48.
 * @param {string} host
 */
function isTailnetIpv6(host) {
  const groups = expandIpv6(host);
  if (!groups) return false;
  return groups[0] === 0xfd7a && groups[1] === 0x115c && groups[2] === 0xa1e0;
}

/** @param {string} host @returns {number[] | null} */
function expandIpv6(host) {
  if (!host || host.includes(".")) return null;
  const halves = host.split("::");
  if (halves.length > 2) return null;
  const parse = (text) => {
    if (!text) return [];
    return text.split(":").map((part) => (/^[0-9a-f]{1,4}$/.test(part) ? Number.parseInt(part, 16) : NaN));
  };
  const left = parse(halves[0] ?? "");
  const right = halves.length === 2 ? parse(halves[1] ?? "") : [];
  if ([...left, ...right].some((n) => !Number.isInteger(n) || n < 0 || n > 0xffff)) return null;
  if (halves.length === 1) return left.length === 8 ? left : null;
  const missing = 8 - left.length - right.length;
  if (missing < 1) return null;
  return [...left, ...Array(missing).fill(0), ...right];
}
