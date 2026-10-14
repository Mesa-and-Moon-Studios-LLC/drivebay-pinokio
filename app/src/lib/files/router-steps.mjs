import { networkInterfaces } from "node:os";

/** True for a dotted IPv4 address with each part in 0-255. */
export function isIpv4(value) {
  const text = String(value ?? "").trim();
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(text)) return false;
  return text.split(".").every((part) => {
    const n = Number(part);
    return n >= 0 && n <= 255 && String(n) === String(Number(part));
  });
}

function isPrivateLan(ip) {
  if (ip.startsWith("10.") || ip.startsWith("192.168.")) return true;
  const match = /^172\.(\d+)\./.exec(ip);
  if (!match) return false;
  const second = Number(match[1]);
  return second >= 16 && second <= 31;
}

/** This PC's LAN IPv4, preferring a private address. Empty when none is found. */
export function localLanIpv4() {
  const nets = networkInterfaces();
  const found = [];
  for (const list of Object.values(nets)) {
    for (const net of list || []) {
      const family = net.family;
      if (family !== "IPv4" && family !== 4) continue;
      if (net.internal) continue;
      if (!isIpv4(net.address)) continue;
      if (net.address.startsWith("169.254.")) continue;
      found.push(net.address);
    }
  }
  return found.find(isPrivateLan) || found[0] || "";
}
