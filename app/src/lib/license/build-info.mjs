/**
 * Build time in seconds, used to apply a license's "updates until" date.
 * A vite build replaces __DRIVEBAY_BUILD_TS__ (see vite.config.ts). Plain node (tests, scripts) falls back to now.
 */
/* global __DRIVEBAY_BUILD_TS__ */
export function buildTimestamp() {
  try {
    // eslint-disable-next-line no-undef
    if (typeof __DRIVEBAY_BUILD_TS__ !== "undefined") return Number(__DRIVEBAY_BUILD_TS__);
  } catch {
    /* not defined */
  }
  return Math.floor(Date.now() / 1000);
}
