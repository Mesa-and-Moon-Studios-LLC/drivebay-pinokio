import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { donateLinks, DONATE_GITHUB_SPONSORS_URL, DONATE_KOFI_URL, DONATE_PAYPAL_URL } from "../app/src/lib/donate.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PAYPAL_URL =
  "https://www.paypal.com/donate/?business=AAGD9Q6BU4WCE&currency_code=USD&item_name=Support%20Drivebay%20-%20Mesa%20and%20Moon%20Studios";
const KOFI_URL = "https://ko-fi.com/mesaandmoonstudios";

test("donate links keep PayPal and Ko-fi, and a blank URL drops that choice", () => {
  assert.equal(DONATE_GITHUB_SPONSORS_URL, "");
  assert.equal(DONATE_PAYPAL_URL, PAYPAL_URL);
  assert.equal(DONATE_KOFI_URL, KOFI_URL);
  assert.deepEqual(donateLinks(), [
    { label: "PayPal", url: PAYPAL_URL },
    { label: "Ko-fi", url: KOFI_URL },
  ]);
  assert.deepEqual(
    donateLinks([
      { label: "GitHub Sponsors", url: "" },
      { label: "PayPal", url: "   " },
      { label: "Ko-fi", url: "https://ko-fi.com/example" },
    ]),
    [{ label: "Ko-fi", url: "https://ko-fi.com/example" }],
  );
});

test("the settings Donate button is a menu and stays hidden while every URL is blank", () => {
  const menu = fs.readFileSync(path.join(root, "app/src/components/settings/donate-menu.tsx"), "utf8");
  assert.match(menu, /if \(links\.length === 0\) return null/);
  assert.match(menu, />\s*Donate\s*</);
  assert.match(menu, /GitHub Sponsors, PayPal, or Ko-fi/);
  assert.match(menu, /target="_blank"/);
  assert.match(menu, /rel="noopener"/);
  assert.match(menu, /\{link\.label\}/);
  const settings = fs.readFileSync(path.join(root, "app/src/routes/settings.tsx"), "utf8");
  assert.match(settings, /<DonateMenu \/>/);
  assert.match(settings, /<SupportBanner \/>/);
  const banner = fs.readFileSync(path.join(root, "app/src/components/support-banner.tsx"), "utf8");
  assert.match(banner, /Enjoying Drivebay\?/);
  assert.match(banner, /drivebay\.supportBanner\.dismissed/);
  assert.match(banner, /Hide support banner/);
  assert.match(banner, /Ko-fi/);
  assert.match(banner, /PayPal/);
  assert.match(menu, /Show the support banner again/);
  const home = fs.readFileSync(path.join(root, "app/src/routes/index.tsx"), "utf8");
  assert.match(home, /<SupportBanner \/>/);
});

test("FUNDING.yml and the README keep the donate placeholders commented", () => {
  const funding = fs.readFileSync(path.join(root, ".github/FUNDING.yml"), "utf8");
  assert.match(funding, /^# github: lordstryfe$/m);
  assert.equal(funding.split("\n").some((line) => /^github:/.test(line)), false);
  assert.match(funding, /^ko_fi: mesaandmoonstudios$/m);
  assert.match(funding, new RegExp(`^custom: \\['${PAYPAL_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}'\\]$`, "m"));
  assert.match(funding, /app\/src\/lib\/donate\.mjs/);
  const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
  const sectionStart = readme.indexOf("## Support Drivebay");
  const changelog = readme.indexOf("## Changelog");
  assert.ok(sectionStart !== -1 && changelog > sectionStart);
  const section = readme.slice(sectionStart, changelog);
  assert.match(section, /DONATE_GITHUB_SPONSORS_URL/);
  assert.match(section, /DONATE_PAYPAL_URL/);
  assert.match(section, /DONATE_KOFI_URL/);
  assert.match(section, /github: lordstryfe/);
  assert.ok(section.includes(PAYPAL_URL));
  assert.ok(section.includes(KOFI_URL));
  assert.match(section, /ko_fi: mesaandmoonstudios/);
});
