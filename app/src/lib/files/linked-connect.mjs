/**
 * Talk to another Drivebay machine directly.
 * The account cloud is not asked for a token or a folder.
 */

export async function confirmDesktop(url, publicKey, fetchImpl = fetch) {
  const origin = new URL(url).origin;
  let res;
  try {
    res = await fetchImpl(`${origin}/api/link/whoami`);
  } catch {
    return { ok: false, error: "That machine did not answer." };
  }
  if (!res.ok) return { ok: false, error: "That machine did not answer." };
  const body = await res.json();
  if (String(body.publicKey || "") !== String(publicKey || "")) {
    return { ok: false, error: "That machine's key does not match the Mesa and Moon account." };
  }
  return { ok: true };
}

export async function redeemRemote({ url, code, machineId, displayName, fetchImpl = fetch }) {
  const origin = new URL(url).origin;
  const res = await fetchImpl(`${origin}/api/link/redeem`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, machineId, displayName }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.token) return { ok: false, error: body.error || "That machine refused the code." };
  return { ok: true, token: String(body.token) };
}

export async function requestRemote({ url, machineId, displayName, secret, fetchImpl = fetch }) {
  const origin = new URL(url).origin;
  const res = await fetchImpl(`${origin}/api/link/request`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ machineId, displayName, secret }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.id) return { ok: false, error: body.error || "That machine did not take the request." };
  return { ok: true, id: String(body.id) };
}

export async function pollRemote({ url, id, secret, fetchImpl = fetch }) {
  const origin = new URL(url).origin;
  const res = await fetchImpl(`${origin}/api/link/poll`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, secret }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.token) return { ok: false, error: body.error || "Still waiting for approval on that machine." };
  return { ok: true, token: String(body.token) };
}
