import { getRequest, getRequestIP } from "@tanstack/react-start/server";
import { isAndroidUserAgent } from "./client-surface.mjs";
import { isLoopbackAddress } from "./loopback.mjs";
import { isTailnetAddress } from "./tailnet.mjs";

type NodeRequest = Request & {
  ip?: string;
  runtime?: { node?: { req?: { socket?: { remoteAddress?: string | null } } } };
};

/** TCP peer address. Forwarded headers are ignored so a LAN client cannot pretend to be this PC. */
export function clientAddress(): string | null {
  try {
    const request = getRequest() as NodeRequest;
    const socketAddress = request.runtime?.node?.req?.socket?.remoteAddress;
    if (socketAddress) return socketAddress;
    if (typeof request.ip === "string" && request.ip.trim()) return request.ip.trim();
  } catch {
    /* no request scope */
  }
  try {
    const ip = getRequestIP();
    if (ip && ip.trim()) return ip.trim();
  } catch {
    /* no request scope */
  }
  return null;
}

export function isLoopbackRequest(): boolean {
  return isLoopbackAddress(clientAddress());
}

export function isTailnetRequest(): boolean {
  return isTailnetAddress(clientAddress());
}

export function isAndroidAppRequest(): boolean {
  try {
    const request = getRequest();
    return isAndroidUserAgent(request.headers.get("user-agent"));
  } catch {
    return false;
  }
}

/** This PC's own browser. The Android app is never the PC, even on a loopback tunnel. */
export function isPcAdminRequest(): boolean {
  return isLoopbackRequest() && !isAndroidAppRequest();
}

function forbidden(message: string): Error {
  const err = new Error(message);
  Object.assign(err, { status: 403, statusCode: 403 });
  return err;
}

export function assertLoopbackRequest(): void {
  if (!isLoopbackRequest()) {
    throw forbidden("Server settings are only available on this PC.");
  }
}

export function assertPcAdmin(): void {
  if (!isPcAdminRequest()) {
    throw forbidden("Server settings are only available on this PC.");
  }
}

/** This PC, or a signed-in caller on the tailnet. The session check stays on the server function. */
export function assertPublicAccessEditor(): void {
  if (isLoopbackRequest() || isTailnetRequest()) return;
  throw new Error("Public access can only be changed on this PC or over Tailscale.");
}
