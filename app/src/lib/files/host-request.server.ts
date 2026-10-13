import { getRequest, getRequestIP } from "@tanstack/react-start/server";
import { isLoopbackAddress } from "./loopback.mjs";

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

export function assertLoopbackRequest(): void {
  if (!isLoopbackRequest()) {
    throw new Error("Server lock can only be changed on this PC.");
  }
}
