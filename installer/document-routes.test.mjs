import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  documentErrorAction,
  homeLocation,
  isSpaDocument,
  isStaticAssetPath,
  replacementForDocumentError,
  signInPageHtml,
  wantsJsonError,
} from "../app/src/lib/files/document-request.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const browserAccept =
  "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8";

test("browser navigations are documents and API calls stay JSON", () => {
  assert.equal(wantsJsonError("/", browserAccept), false);
  assert.equal(wantsJsonError("/", null), false);
  assert.equal(wantsJsonError("/", ""), false);
  assert.equal(wantsJsonError("/", "*/*"), false);
  assert.equal(wantsJsonError("/", "application/json, text/html"), false);
  assert.equal(wantsJsonError("/", "application/json"), true);
  assert.equal(wantsJsonError("/api/auth/get-session", browserAccept), true);
  assert.equal(wantsJsonError("/api", "text/html"), true);
  assert.equal(wantsJsonError("/_serverFn/abc", browserAccept), true);

  assert.equal(isStaticAssetPath("/assets/index.js"), true);
  assert.equal(isStaticAssetPath("/favicon.svg"), true);
  assert.equal(isStaticAssetPath("/__grok/manifest.webmanifest"), true);
  assert.equal(isStaticAssetPath("/"), false);
  assert.equal(isStaticAssetPath("/login"), false);
  assert.equal(isStaticAssetPath("/settings"), false);

  assert.equal(isSpaDocument("/", browserAccept, "GET"), true);
  assert.equal(isSpaDocument("/", browserAccept, "HEAD"), true);
  assert.equal(isSpaDocument("/", "application/json", "GET"), false);
  assert.equal(isSpaDocument("/api/download", browserAccept, "GET"), false);
  assert.equal(isSpaDocument("/assets/app.js", browserAccept, "GET"), false);
  assert.equal(isSpaDocument("/", browserAccept, "POST"), false);
});

test("loopback / is sign-in or settings, and Tailscale / stays the file UI", () => {
  assert.equal(homeLocation("/", "127.0.0.1", false), "/login");
  assert.equal(homeLocation("/", "localhost", false), "/login");
  assert.equal(homeLocation("/", "::1", true), "/settings");
  assert.equal(homeLocation("/", "[::1]", true), "/settings");
  assert.equal(homeLocation("/", "100.80.180.121", false), null);
  assert.equal(homeLocation("/", "100.80.180.121", true), null);
  assert.equal(homeLocation("/settings", "127.0.0.1", true), null);
  assert.equal(homeLocation("/login", "127.0.0.1", false), null);
});

test("document auth JSON becomes a page, and API JSON is left alone", () => {
  const unauthorized = '{"error":"Unauthorized"}';
  const forbidden = '{"error":"Forbidden"}';
  assert.equal(
    documentErrorAction("/", 401, "application/json", unauthorized),
    "redirect",
  );
  assert.equal(
    documentErrorAction("/", 403, "application/json", forbidden),
    "redirect",
  );
  assert.equal(
    documentErrorAction("/", 200, "application/json", unauthorized),
    "redirect",
  );
  assert.equal(
    documentErrorAction("/", 200, "application/json", forbidden),
    "redirect",
  );
  assert.equal(documentErrorAction("/login", 401, "application/json", unauthorized), "html");
  assert.equal(documentErrorAction("/", 302, "text/html", ""), null);
  assert.equal(documentErrorAction("/", 200, "text/html", "<!doctype html>"), null);
  assert.equal(
    documentErrorAction("/api/auth/get-session", 401, "application/json", unauthorized),
    null,
  );
  assert.equal(
    documentErrorAction("/settings", 406, "application/json", '{"error":"Only HTML requests are supported here"}'),
    "redirect",
  );

  const replaced = replacementForDocumentError(
    "http://127.0.0.1:42051/",
    "/",
    401,
    "application/json",
    unauthorized,
  );
  assert.equal(replaced.status, 302);
  assert.equal(replaced.headers.get("location"), "http://127.0.0.1:42051/login");

  const remote = replacementForDocumentError(
    "http://100.80.180.121:42051/",
    "/",
    403,
    "application/json",
    forbidden,
  );
  assert.equal(remote.status, 302);
  assert.equal(remote.headers.get("location"), "http://100.80.180.121:42051/login");

  const login = replacementForDocumentError(
    "http://127.0.0.1:42051/login",
    "/login",
    401,
    "application/json",
    unauthorized,
  );
  assert.equal(login.status, 200);
  assert.match(login.headers.get("content-type"), /text\/html/);
  const html = signInPageHtml();
  assert.match(html, /Sign in/);
  assert.equal(html.includes('{"error"'), false);

  const api = replacementForDocumentError(
    "http://127.0.0.1:42051/api/download",
    "/api/download",
    401,
    "application/json",
    unauthorized,
  );
  assert.equal(api, null);
});

test("static files stay ahead of auth, and server-lock writes stay on this PC", () => {
  const start = fs.readFileSync(path.join(root, "app/src/start.ts"), "utf8");
  const middlewareList = start.slice(start.indexOf("requestMiddleware"));
  assert.match(start, /requestMiddleware:\s*\[documentMiddleware,\s*csrfMiddleware\]/);
  assert.ok(middlewareList.indexOf("documentMiddleware") < middlewareList.indexOf("csrfMiddleware"));
  assert.equal(start.includes("requireUserId"), false);
  assert.match(start, /handlerType === "serverFn"/);
  assert.match(start, /getSessionUser/);

  const vite = fs.readFileSync(path.join(root, "app/vite.config.ts"), "utf8");
  assert.match(vite, /serverDir:\s*"\.\/server"/);

  const auth = fs.readFileSync(path.join(root, "app/src/lib/auth/middleware.ts"), "utf8");
  assert.match(auth, /type:\s*"function"/);

  const api = fs.readFileSync(path.join(root, "app/src/lib/files/api.functions.ts"), "utf8");
  const save = api.slice(api.indexOf("export const saveServerLock"));
  const restart = api.slice(api.indexOf("export const restartDrivebay"));
  assert.ok(save.indexOf("assertLoopbackRequest") !== -1);
  assert.ok(save.indexOf("assertLoopbackRequest") < save.indexOf("writeServerLock"));
  assert.ok(restart.indexOf("assertLoopbackRequest") !== -1);
  assert.ok(restart.indexOf("assertLoopbackRequest") < restart.indexOf("scheduleStandaloneRestart"));

  const host = fs.readFileSync(path.join(root, "app/src/lib/files/host-request.server.ts"), "utf8");
  assert.equal(host.includes("x-forwarded-for"), false);
  assert.equal(host.includes("xForwardedFor"), false);

  const launcher = fs.readFileSync(path.join(root, "installer/launcher.mjs"), "utf8");
  assert.match(launcher, /openBrowser\(`\$\{origin\}\/settings`\)/);
  const tray = fs.readFileSync(path.join(root, "installer/tray/DrivebayTray.cs"), "utf8");
  assert.match(tray, /ReadPort\(\) \+ "\/settings"/);
});
