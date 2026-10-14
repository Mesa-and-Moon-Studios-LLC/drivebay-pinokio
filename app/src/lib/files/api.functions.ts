import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware } from "@/lib/auth/middleware";
import type { DirListing, Drive, PreviewPayload, SearchResult } from "./types";

export const hasOwner = createServerFn({ method: "GET" }).handler(async () => {
  const { accountFirstRun } = await import("@/lib/auth/pending-account.server");
  const first = await accountFirstRun();
  return { owned: first.mode === "unlock", username: first.username };
});

export const listDrives = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async (): Promise<Drive[]> => {
    const access = await import("./drive-access.server");
    const lock = await import("./server-lock.server");
    // Live scan every call; apply Settings drive toggles, then optional host lock roots.
    let drives = await access.listEnabledDrives();
    const policy = lock.readServerLock();
    if (policy.allowedRoots.length) {
      drives = drives.filter((d) => lock.isPathAllowedByRoots(d.path, policy.allowedRoots));
    }
    return drives;
  });

export const listEntries = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ path: z.string().min(1), showHidden: z.boolean() }))
  .handler(async ({ data }): Promise<DirListing> => {
    const fs = await import("./fs.server");
    const lock = await import("./server-lock.server");
    const access = await import("./drive-access.server");
    const resolved = fs.resolveSafePath(data.path);
    lock.assertPathAllowed(resolved);
    await access.assertPathAllowedByDriveAccess(resolved);
    return fs.listEntries(data.path, data.showHidden);
  });

export const getPreview = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ path: z.string().min(1) }))
  .handler(async ({ data }): Promise<PreviewPayload> => {
    const fs = await import("./fs.server");
    const lock = await import("./server-lock.server");
    const access = await import("./drive-access.server");
    const resolved = fs.resolveSafePath(data.path);
    lock.assertPathAllowed(resolved);
    await access.assertPathAllowedByDriveAccess(resolved);
    const ext = fs.extOf(resolved);
    if (fs.isImageExt(ext)) {
      return { kind: "image", mime: fs.mimeOf(ext) };
    }
    if (fs.isTextExt(ext)) {
      const preview = await fs.readTextPreview(resolved);
      return { kind: "text", ...preview };
    }
    try {
      const preview = await fs.readTextPreview(resolved, 24_000);
      return { kind: "text", ...preview };
    } catch {
      return { kind: "binary" };
    }
  });

export const createFolder = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ parent: z.string().min(1), name: z.string().min(1).max(255) }))
  .handler(async ({ data }) => {
    const fs = await import("./fs.server");
    const lock = await import("./server-lock.server");
    const access = await import("./drive-access.server");
    lock.assertPolicy("allowCreateFolder");
    const parentResolved = fs.resolveSafePath(data.parent);
    lock.assertPathAllowed(parentResolved);
    await access.assertPathAllowedByDriveAccess(parentResolved);
    const path = await fs.createFolder(data.parent, data.name);
    return { path };
  });

export const renameEntry = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ path: z.string().min(1), name: z.string().min(1).max(255) }))
  .handler(async ({ data }) => {
    const fs = await import("./fs.server");
    const lock = await import("./server-lock.server");
    const access = await import("./drive-access.server");
    lock.assertPolicy("allowRename");
    const resolved = fs.resolveSafePath(data.path);
    lock.assertPathAllowed(resolved);
    await access.assertPathAllowedByDriveAccess(resolved);
    const path = await fs.renameEntry(data.path, data.name);
    return { path };
  });

export const deleteEntry = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ path: z.string().min(1) }))
  .handler(async ({ data }) => {
    const fs = await import("./fs.server");
    const lock = await import("./server-lock.server");
    const access = await import("./drive-access.server");
    lock.assertPolicy("allowDelete");
    const resolved = fs.resolveSafePath(data.path);
    lock.assertPathAllowed(resolved);
    await access.assertPathAllowedByDriveAccess(resolved);
    await fs.removeEntry(data.path);
    return { ok: true as const };
  });

export const uploadFile = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    z.object({
      parent: z.string().min(1),
      name: z.string().min(1).max(255),
      contentBase64: z.string().min(1),
    }),
  )
  .handler(async ({ data }) => {
    const fs = await import("./fs.server");
    const lock = await import("./server-lock.server");
    const access = await import("./drive-access.server");
    lock.assertPolicy("allowUpload");
    const parentResolved = fs.resolveSafePath(data.parent);
    lock.assertPathAllowed(parentResolved);
    await access.assertPathAllowedByDriveAccess(parentResolved);
    const buf = Buffer.from(data.contentBase64, "base64");
    lock.assertUploadSize(buf.length);
    const path = await fs.writeUpload(data.parent, data.name, buf);
    return { path, size: buf.length };
  });

export const readFileBase64 = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ path: z.string().min(1) }))
  .handler(async ({ data }) => {
    const { promises: fsp } = await import("node:fs");
    const fs = await import("./fs.server");
    const lock = await import("./server-lock.server");
    const access = await import("./drive-access.server");
    const resolved = fs.resolveSafePath(data.path);
    lock.assertPathAllowed(resolved);
    await access.assertPathAllowedByDriveAccess(resolved);
    const st = await fsp.stat(resolved);
    if (!st.isFile()) throw new Error("Not a file");
    // Inline base64 is only for small previews (images). Large downloads use /api/download.
    if (st.size > 32 * 1024 * 1024) {
      throw new Error("File is too large to preview — use Download");
    }
    const bytes = await fsp.readFile(resolved);
    return {
      name: resolved.split(/[\\/]/).pop() ?? "file",
      mime: fs.mimeOf(fs.extOf(resolved)),
      contentBase64: bytes.toString("base64"),
      size: st.size,
    };
  });

export const searchFiles = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    z.object({
      root: z.string().min(1),
      query: z.string().min(2).max(120),
      showHidden: z.boolean(),
    }),
  )
  .handler(async ({ data }): Promise<SearchResult> => {
    const fs = await import("./fs.server");
    const lock = await import("./server-lock.server");
    const access = await import("./drive-access.server");
    const resolved = fs.resolveSafePath(data.root);
    lock.assertPathAllowed(resolved);
    await access.assertPathAllowedByDriveAccess(resolved);
    return fs.searchEntries(data.root, data.query, data.showHidden);
  });

export const getRouterHelp = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async () => {
    const settings = await import("./settings.server");
    const mode = settings.readReachMode();
    const port = settings.readPortSettings().port;
    if (mode !== "regular") return { mode, port, localIp: "", publicIp: "" };
    return {
      mode,
      port,
      localIp: settings.thisPcLanIp(),
      publicIp: await settings.lookupPublicIpv4(),
    };
  });

export const getSettings = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async () => {
    const settings = await import("./settings.server");
    const lock = await import("./server-lock.server");
    const access = await import("./drive-access.server");
    const driveAccess = await access.listDrivesWithAccess();
    const host = await import("./host-request.server");
    return {
      ...settings.readAppSettings(),
      serverLock: lock.toPublicServerLock(lock.readServerLock(), host.isLoopbackRequest()),
      driveAccess,
    };
  });

export const saveDriveAccess = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    z.object({
      /** Drive ids that should be OFF. Omitted ids stay on. */
      disabledIds: z.array(z.string().min(1).max(64)).max(64),
    }),
  )
  .handler(async ({ data }) => {
    const access = await import("./drive-access.server");
    access.writeDriveAccess(data.disabledIds);
    return access.listDrivesWithAccess();
  });

export const savePortSettings = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    z.object({
      style: z.enum(["random", "static"]),
      port: z.number().int().min(1024).max(65535),
    }),
  )
  .handler(async ({ data }) => {
    const settings = await import("./settings.server");
    const lock = await import("./server-lock.server");
    lock.assertPolicy("allowPortChangeFromUi");
    return settings.writePortSettings(data.style, data.port);
  });

const serverLockInput = z.object({
  allowPortChangeFromUi: z.boolean(),
  allowDelete: z.boolean(),
  allowRename: z.boolean(),
  allowCreateFolder: z.boolean(),
  allowUpload: z.boolean(),
  maxUploadMb: z.number().int().min(1).max(8192),
  allowedRoots: z.array(z.string().trim().min(1).max(400)).max(64),
});

export const saveServerLock = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(serverLockInput)
  .handler(async ({ data }) => {
    const host = await import("./host-request.server");
    host.assertLoopbackRequest();
    const lock = await import("./server-lock.server");
    const saved = lock.writeServerLock(data);
    return {
      applied: saved.applied,
      serverLock: lock.toPublicServerLock(saved.policy, true),
    };
  });

export const restartDrivebay = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .handler(async () => {
    const host = await import("./host-request.server");
    host.assertLoopbackRequest();
    const restart = await import("./host-restart.server");
    return restart.scheduleStandaloneRestart();
  });
