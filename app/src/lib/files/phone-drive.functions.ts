import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware } from "@/lib/auth/middleware";

export const mountPhoneDrive = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    z.object({
      url: z.string().min(1).max(300),
      secret: z.string().min(8).max(200),
      letter: z.string().max(8).optional(),
    }),
  )
  .handler(async ({ data }) => {
    const host = await import("./host-request.server");
    host.assertPcAdmin();
    const drive = await import("./phone-drive.mjs");
    const plan = drive.mountPlan({
      platform: process.platform,
      url: data.url,
      secret: data.secret,
      letter: data.letter || "Z",
      user: "drivebay",
    });
    if (!plan.ok) return { ok: false as const, message: plan.error || "Cannot mount", display: "" };
    const result = await drive.runMount(plan);
    return {
      ok: result.code === 0,
      message: drive.redact(result.output, data.secret),
      display: plan.display,
    };
  });
