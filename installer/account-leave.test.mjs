import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const installerDir = path.dirname(fileURLToPath(import.meta.url));

/** Same character rules as UsernameOk in drivebay.nsi. */
export function usernameOk(username) {
  if (username.length < 1 || username.length > 64) return false;
  for (let i = 0; i < username.length; i++) {
    const c = username[i];
    let ok = false;
    if (c >= "0" && c <= "9") ok = true;
    if (c >= "A" && c <= "Z") ok = true;
    if (c >= "a" && c <= "z") ok = true;
    if (i > 0 && (c === "." || c === "-" || c === "_")) ok = true;
    if (!ok) return false;
  }
  return true;
}

/**
 * AccountPageLeave after the confirm password is stored in $Confirm.
 * UsernameOk used to overwrite $1, which held the confirm field, so this
 * comparison never saw the second box.
 */
export function accountPageLeave({ username, password, confirm }) {
  if (!usernameOk(username)) return "username";
  if (password.length < 8) return "short";
  if (password !== confirm) return "mismatch";
  return "ok";
}

/** The 3.18 bug: confirm lived in $1, then UsernameOk did StrLen $1 $Username. */
function clobberedConfirm(username, password, confirm) {
  let reg1 = confirm;
  reg1 = String(username.length);
  if (password !== reg1) return "mismatch";
  return "ok";
}

function functionBody(src, name) {
  const start = src.indexOf(`Function ${name}`);
  assert.notEqual(start, -1, `missing Function ${name}`);
  const end = src.indexOf("\nFunctionEnd", start);
  assert.notEqual(end, -1, `missing FunctionEnd for ${name}`);
  return src.slice(start, end);
}

test("matching passwords pass and are the value that gets saved", () => {
  assert.equal(
    accountPageLeave({ username: "owner", password: "password1", confirm: "password1" }),
    "ok",
  );
  assert.equal(
    accountPageLeave({ username: "a.b_c-d", password: "12345678", confirm: "12345678" }),
    "ok",
  );
});

test("mismatched, empty, and short passwords are rejected", () => {
  assert.equal(
    accountPageLeave({ username: "owner", password: "password1", confirm: "password2" }),
    "mismatch",
  );
  assert.equal(accountPageLeave({ username: "owner", password: "", confirm: "" }), "short");
  assert.equal(
    accountPageLeave({ username: "owner", password: "short", confirm: "short" }),
    "short",
  );
  assert.equal(
    accountPageLeave({ username: "owner", password: "password1", confirm: "" }),
    "mismatch",
  );
  assert.equal(accountPageLeave({ username: "", password: "password1", confirm: "password1" }), "username");
  assert.equal(accountPageLeave({ username: ".owner", password: "password1", confirm: "password1" }), "username");
});

test("the old $1 clobber rejects identical passwords", () => {
  assert.equal(clobberedConfirm("owner", "password1", "password1"), "mismatch");
  assert.equal(accountPageLeave({ username: "owner", password: "password1", confirm: "password1" }), "ok");
});

test("installer script keeps confirm in $Confirm and skips the router page for Tailscale", () => {
  const src = fs.readFileSync(path.join(installerDir, "drivebay.nsi"), "utf8");
  for (const ch of src) {
    assert.ok(ch.charCodeAt(0) <= 127, `non-ASCII installer character ${JSON.stringify(ch)}`);
  }
  assert.match(src, /Tailscale - reach Drivebay over your tailnet/);
  assert.match(src, /Regular - this network, without Tailscale/);
  assert.equal(src.includes("\u2014"), false);
  assert.equal(src.includes("\u2013"), false);

  const leave = functionBody(src, "AccountPageLeave");
  const confirmRead = leave.indexOf("${NSD_GetText} $ConfirmField $Confirm");
  const usernameCall = leave.indexOf("Call UsernameOk");
  assert.ok(confirmRead !== -1 && confirmRead < usernameCall);
  assert.equal(leave.includes("${NSD_GetText} $ConfirmField $1"), false);
  assert.match(leave, /\$Password != \$Confirm/);
  assert.doesNotMatch(leave, /\$Password != \$1/);

  const usernameOk = functionBody(src, "UsernameOk");
  assert.doesNotMatch(usernameOk, /\$1/);
  assert.match(usernameOk, /StrLen \$R1 \$Username/);

  const router = functionBody(src, "RouterPageCreate");
  const abortAt = router.indexOf('Abort');
  const dialogAt = router.indexOf("nsDialogs::Create");
  assert.match(router, /\$Mode == "tailscale"/);
  assert.ok(abortAt !== -1 && abortAt < dialogAt);

  const port = functionBody(src, "PortPageCreate");
  const portDialog = port.indexOf("nsDialogs::Create");
  assert.ok(portDialog !== -1);
  assert.match(port, /\$Update == "1"/);
  assert.equal(port.slice(portDialog).includes("Abort"), false);
  assert.match(port, /1024-65535/);
  assert.match(port, /You do not open it on your router/);

  const tailscale = functionBody(src, "TailscalePageCreate");
  assert.equal(tailscale.includes("forward TCP port"), false);
  assert.match(tailscale, /Do you already have Tailscale\?/);

  for (const file of ["write-setup.ps1", "launch-tailscale.ps1", "install-tailscale.ps1", "firewall.ps1"]) {
    const text = fs.readFileSync(path.join(installerDir, "windows", file), "utf8");
    for (const ch of text) {
      assert.ok(ch.charCodeAt(0) <= 127, `${file} has non-ASCII ${JSON.stringify(ch)}`);
    }
  }
});
