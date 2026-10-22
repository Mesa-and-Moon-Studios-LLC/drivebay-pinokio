import { createFileRoute } from "@tanstack/react-router";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { assertPcAdmin } from "@/lib/files/host-request.server";
import { applyPlan } from "@/lib/files/update-apply.mjs";
import { platformId, writeUpdateStatus } from "@/lib/files/update-policy.mjs";
import { APP_VERSION } from "@/lib/version";

function applyScript(): string {
  const candidates = [
    process.env.DRIVEBAY_PROGRAM ? path.join(process.env.DRIVEBAY_PROGRAM, "update-apply.mjs") : "",
    path.resolve(process.cwd(), "..", "update-apply.mjs"),
  ];
  for (const file of candidates) {
    if (file && fs.existsSync(file)) return file;
  }
  return "";
}

export const Route = createFileRoute("/api/update-apply")({
  server: {
    handlers: {
      POST: async () => {
        try {
          assertPcAdmin();
        } catch {
          return Response.json({ ok: false, reason: "forbidden" }, { status: 403 });
        }
        const home = process.env.DRIVEBAY_HOME || "";
        if (!home || !fs.existsSync(path.join(home, "config.json"))) {
          return Response.json({ ok: false, reason: "not-installed" }, { status: 409 });
        }
        const script = applyScript();
        if (!script) {
          return Response.json({ ok: false, reason: "unavailable" }, { status: 503 });
        }
        const status = await writeUpdateStatus(home, `Drivebay ${APP_VERSION}`, {
          force: true,
          platform: platformId(),
        });
        const plan = applyPlan(status);
        if (!plan.ok) {
          const code = plan.reason === "no-asset" ? 409 : 200;
          return Response.json(plan, { status: code });
        }
        const child = spawn(process.execPath, [script], {
          detached: true,
          stdio: "ignore",
          windowsHide: true,
          env: {
            ...process.env,
            DRIVEBAY_HOME: home,
            DRIVEBAY_PROGRAM: process.env.DRIVEBAY_PROGRAM || path.dirname(script),
            DRIVEBAY_UPDATE_FORCE: "1",
            DRIVEBAY_VERSION_FILE: path.join(process.env.DRIVEBAY_PROGRAM || path.dirname(script), "VERSION.txt"),
          },
        });
        child.unref();
        return Response.json({ ok: true, started: true, kind: plan.kind }, { status: 202 });
      },
    },
  },
});
