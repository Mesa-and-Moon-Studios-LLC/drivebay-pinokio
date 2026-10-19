import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const candidates = [
  path.join(here, "phone-drive-lib.mjs"),
  path.join(here, "../app/src/lib/files/phone-drive.mjs"),
];
const found = candidates.find((file) => fs.existsSync(file));
if (!found) {
  console.error("Drivebay phone mount helper is missing.");
  process.exit(1);
}
const lib = await import(pathToFileURL(found).href);

const plan = lib.mountPlan({
  platform: process.platform,
  url: process.env.DRIVEBAY_PHONE_URL || "",
  user: process.env.DRIVEBAY_PHONE_USER || "drivebay",
  secret: process.env.DRIVEBAY_PHONE_SECRET || "",
  letter: process.env.DRIVEBAY_PHONE_LETTER || "Z",
  home: process.env.DRIVEBAY_HOME || undefined,
});
if (!plan.ok) {
  console.error(plan.error);
  process.exit(1);
}
const result = await lib.runMount(plan);
const secret = process.env.DRIVEBAY_PHONE_SECRET || "";
const text = lib.redact(result.output, secret);
if (text) console.log(text);
process.exit(result.code === 0 ? 0 : 1);
