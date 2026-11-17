#!/usr/bin/env node
/**
 * Drivebay license admin CLI. Mints purchase codes, promo codes and license keys, and manages seats.
 *
 * Remote (default): talks to the license server's admin API.
 *   DRIVEBAY_ADMIN_TOKEN=<token>  or  --token-file <path>   (default ~/.drivebay-admin-token)
 *   DRIVEBAY_LICENSE_ADMIN_URL    (default https://mesaandmoon.com/drivebay/api/license-admin.php)
 * The signing key never leaves the server. This tool never sees it.
 *
 * Usage:
 *   license-admin.mjs code  --edition pro --seats 3 [--perpetual | --months 12] [--updates-months 12 | --lifetime-updates] [--count 1] [--note "..."]
 *   license-admin.mjs promo --edition pro --seats 1 --months 12 --max 50 [--code-expires-days 30] [--note "launch"]
 *   license-admin.mjs mint  --edition elite --seats 10 --perpetual --lifetime-updates [--label "Aaron"]
 *   license-admin.mjs enterprise-file --org "Acme Corp" --seats 250 (--months 12 | --perpetual --updates-months 12) --out acme.dbaylicense
 *   license-admin.mjs list [licenses|codes|orders|activations] | seats <licenseId> | release <licenseId> <machineRef>
 *   license-admin.mjs revoke <licenseId> [reason] | unrevoke <licenseId> | outbox | outbox-purge
 *   --json prints raw JSON.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const argv = process.argv.slice(2);
const cmd = argv.shift();
const flags = {};
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith("--")) {
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) flags[key] = true;
    else {
      flags[key] = next;
      i++;
    }
  } else positional.push(a);
}

function die(message) {
  console.error(message);
  process.exit(1);
}

function readToken() {
  if (process.env.DRIVEBAY_ADMIN_TOKEN) return process.env.DRIVEBAY_ADMIN_TOKEN.trim();
  const file = typeof flags["token-file"] === "string" ? flags["token-file"] : path.join(os.homedir(), ".drivebay-admin-token");
  try {
    return fs.readFileSync(file, "utf8").trim();
  } catch {
    die(`No admin token. Set DRIVEBAY_ADMIN_TOKEN or put it in ${file} (mode 600).`);
  }
}

const URL_ = process.env.DRIVEBAY_LICENSE_ADMIN_URL || "https://mesaandmoon.com/drivebay/api/license-admin.php";

async function call(body) {
  const res = await fetch(URL_, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", "user-agent": "Drivebay-admin-cli/1.0", "x-drivebay-admin": readToken() },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    die(`Server answered ${res.status}: ${text.slice(0, 200)}`);
  }
  if (!res.ok) die(`Server answered ${res.status}: ${data.error || text}`);
  return data;
}

function termFields() {
  const out = {};
  if (flags.edition) out.edition = String(flags.edition);
  out.seats = Number(flags.seats || 1);
  out.termMonths = flags.perpetual ? 0 : Number(flags.months || 0);
  if (!flags.perpetual && !flags.months) die("Pick --perpetual or --months N.");
  if (flags["lifetime-updates"]) out.updatesMonths = -1;
  else if (flags["updates-months"] !== undefined) out.updatesMonths = Number(flags["updates-months"]);
  if (flags.label) out.label = String(flags.label);
  if (flags.note) out.note = String(flags.note);
  if (flags.offline) out.offline = true;
  return out;
}

const day = (ts) => (ts ? new Date(ts * 1000).toISOString().slice(0, 10) : "never");
function describe(l) {
  return `${l.edition} · ${l.seats} seat(s) · issued ${day(l.issued)} · expires ${l.expires ? day(l.expires) : "never"} · updates until ${l.updatesUntil ? day(l.updatesUntil) : "lifetime"} · id ${l.id}${l.offline ? " · offline" : ""}${l.label ? ` · ${l.label}` : ""}`;
}

async function main() {
  const json = flags.json === true;
  const show = (data, human) => (json ? console.log(JSON.stringify(data, null, 2)) : human());
  switch (cmd) {
    case "code": {
      const data = await call({ action: "code", kind: "purchase", count: Number(flags.count || 1), ...termFields() });
      return show(data, () => data.codes.forEach((c) => console.log(c)));
    }
    case "promo": {
      const data = await call({ action: "code", kind: "promo", count: Number(flags.count || 1), maxLicenses: Number(flags.max || 1), codeExpiresDays: Number(flags["code-expires-days"] || 0), ...termFields() });
      return show(data, () => data.codes.forEach((c) => console.log(c)));
    }
    case "mint": {
      const data = await call({ action: "mint", ...termFields() });
      return show(data, () => {
        console.log(data.licenseKey);
        console.error(describe(data.license));
      });
    }
    case "enterprise-file": {
      if (!flags.org) die("Pass --org \"Company name\".");
      if (!flags.out) die("Pass --out file.dbaylicense.");
      const fields = { ...termFields(), edition: "enterprise", offline: true, label: String(flags.org).slice(0, 48) };
      if (fields.updatesMonths === undefined && fields.termMonths === 0) fields.updatesMonths = 12;
      const data = await call({ action: "mint", ...fields });
      const l = data.license;
      const lines = [
        "-----BEGIN DRIVEBAY LICENSE-----",
        `Licensee: ${l.label}`,
        "Edition: enterprise",
        `Seats: ${l.seats}`,
        `Issued: ${day(l.issued)}`,
        `Term ends: ${l.expires ? day(l.expires) : "perpetual"}`,
        `Updates until: ${l.updatesUntil ? day(l.updatesUntil) : "lifetime"}`,
        `License id: ${l.id}`,
        `Key: ${data.licenseKey}`,
        "-----END DRIVEBAY LICENSE-----",
        "",
      ];
      fs.writeFileSync(String(flags.out), lines.join("\n"), { mode: 0o600 });
      console.error(`Wrote ${flags.out}\n${describe(l)}`);
      return;
    }
    case "list": {
      const what = positional[0] || "licenses";
      const data = await call({ action: "list", what });
      return show(data, () => console.table(data.rows.map((r) => (what === "licenses" ? { id: r.id, edition: r.edition, seats: r.seats, issued: day(r.issued), expires: r.expires ? day(r.expires) : "never", source: r.source, revoked: r.revoked_at ? "yes" : "", label: r.label } : r))));
    }
    case "seats": {
      const data = await call({ action: "seats", id: positional[0] });
      return show(data, () => console.table(data.rows));
    }
    case "release": {
      const data = await call({ action: "release", id: positional[0], machine: positional[1] });
      return show(data, () => console.log(`released ${data.released}`));
    }
    case "revoke": {
      const data = await call({ action: "revoke", id: positional[0], reason: positional.slice(1).join(" ") });
      return show(data, () => console.log(data.revoked ? "revoked" : "nothing to revoke"));
    }
    case "unrevoke": {
      const data = await call({ action: "unrevoke", id: positional[0] });
      return show(data, () => console.log(data.restored ? "restored" : "not found"));
    }
    case "outbox": {
      const data = await call({ action: "outbox" });
      return show(data, () => data.rows.forEach((r) => console.log(`#${r.id} ${r.to_email} [${r.transport}] ${r.subject}\n${r.body}\n`)));
    }
    case "outbox-purge": {
      const data = await call({ action: "outbox-purge" });
      return show(data, () => console.log(`deleted ${data.deleted}`));
    }
    default:
      console.error(fs.readFileSync(new URL(import.meta.url), "utf8").split("*/")[0].replace(/^#!.*\n/, "").replace(/^\/\*\*?\n?/, "").replace(/^ \* ?/gm, ""));
      process.exit(cmd ? 1 : 0);
  }
}
main().catch((err) => die(err.message || String(err)));
