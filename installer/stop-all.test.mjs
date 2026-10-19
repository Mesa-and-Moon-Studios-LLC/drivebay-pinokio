import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ps1 = fs.readFileSync(path.join(here, "windows", "stop-drivebay-all.ps1"), "utf8");
const nsi = fs.readFileSync(path.join(here, "drivebay.nsi"), "utf8");
const pattern = new RegExp(ps1.match(/\$serverPattern = '\(\?i\)(.+)'/)[1], "i");

test("stop-all matches every Drivebay copy's launcher and server", () => {
  for (const cmd of [
    '"C:\\Users\\a\\AppData\\Local\\Drivebay\\runtime\\node.exe" "C:\\Users\\a\\AppData\\Local\\Drivebay\\launcher.mjs"',
    "C:\\Users\\a\\AppData\\Local\\Drivebay\\runtime\\node.exe C:\\Users\\a\\AppData\\Local\\Drivebay\\app\\server\\index.mjs",
    '"C:\\Users\\a\\AppData\\Local\\Programs\\Drivebay\\runtime\\node.exe" "C:\\Users\\a\\AppData\\Local\\Programs\\Drivebay\\launcher.mjs"',
    "C:\\Users\\a\\AppData\\Local\\Programs\\Drivebay\\runtime\\node.exe C:\\Users\\a\\AppData\\Local\\Programs\\Drivebay\\app\\server\\index.mjs",
  ]) assert.match(cmd, pattern, cmd);
});

test("stop-all leaves unrelated node processes alone", () => {
  for (const cmd of [
    "node C:\\projects\\other\\launcher.mjs",
    "node C:\\projects\\site\\app\\server\\index.mjs",
    "node C:\\Users\\a\\Drivebay-notes\\readme.mjs",
  ]) assert.doesNotMatch(cmd, pattern, cmd);
});

test("installer stops all Drivebay copies before choosing a port and before installing", () => {
  const init = nsi.slice(nsi.indexOf("Function .onInit"), nsi.indexOf("FunctionEnd", nsi.indexOf("Function .onInit")));
  assert.ok(init.indexOf("Call StopAllDrivebay") >= 0);
  assert.ok(init.indexOf("Call StopAllDrivebay") < init.indexOf("Call DetectUpdate"));
  assert.ok(init.indexOf("Call DetectUpdate") < init.indexOf("Call SuggestFreePort"));
  const section = nsi.slice(nsi.indexOf('Section "Install"'));
  assert.ok(section.indexOf("Call StopAllDrivebay") < section.indexOf('File /r "staging'));
});

test("a saved drivebay.port is kept on a fresh install", () => {
  const fn = nsi.slice(nsi.indexOf("Function SuggestFreePort"));
  assert.ok(fn.indexOf("drivebay.port") < fn.indexOf("nsExec::ExecToStack"));
});

test("release version has no test suffix", () => {
  assert.match(nsi, /!define VERSION "3\.36\.1"/);
  const v = fs.readFileSync(path.join(here, "..", "app", "src", "lib", "version.ts"), "utf8");
  assert.match(v, /APP_VERSION = "3\.36\.1"/);
});
