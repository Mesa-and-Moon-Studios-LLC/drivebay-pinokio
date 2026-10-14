/**
 * Which surface is showing the web UI.
 * The Android app adds DriveBayAndroid/ to the WebView user agent and
 * sets window.__DRIVEBAY_ANDROID. Server settings stay off both of those.
 */
import { pageAfterSignIn } from "../host-page.mjs";

export function isAndroidUserAgent(userAgent) {
  return /DriveBayAndroid\//i.test(String(userAgent ?? ""));
}

export function isAndroidApp() {
  if (typeof navigator !== "undefined" && isAndroidUserAgent(navigator.userAgent)) return true;
  if (typeof window === "undefined") return false;
  if (window.__DRIVEBAY_ANDROID) return true;
  return Boolean(window.DrivebayNative);
}

/** Loopback hostname, and not the Android app. */
export function settingsOnThisPc(hostname) {
  return pageAfterSignIn(hostname ?? "", null) === "/settings" && !isAndroidApp();
}
