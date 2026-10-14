/**
 * What other devices may do. This PC is always allowed.
 * A missing file keeps today's behavior: delete on, upload and rename on.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const REMOTE_DELETE_OFF = "Delete from other devices is turned off on this PC.";
export const REMOTE_UPLOAD_OFF = "Upload and rename from other devices are turned off on this PC.";

export function defaultRemoteActions() {
  return {
    allowDeleteFromOtherDevices: true,
    allowUploadRenameFromOtherDevices: true,
  };
}

export function normalizeRemoteActions(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  return {
    allowDeleteFromOtherDevices: src.allowDeleteFromOtherDevices !== false,
    allowUploadRenameFromOtherDevices: src.allowUploadRenameFromOtherDevices !== false,
  };
}

export function readRemoteActionsFile(file) {
  try {
    return normalizeRemoteActions(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    return defaultRemoteActions();
  }
}

export function writeRemoteActionsFile(file, input) {
  const next = normalizeRemoteActions(input);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}

/**
 * @param {"delete" | "upload" | "rename" | "move"} action
 * @param {boolean} onThisPc
 */
export function remoteActionAllowed(policy, action, onThisPc) {
  if (onThisPc) return true;
  const rules = normalizeRemoteActions(policy);
  if (action === "delete") return rules.allowDeleteFromOtherDevices;
  if (action === "upload" || action === "rename" || action === "move") {
    return rules.allowUploadRenameFromOtherDevices;
  }
  return true;
}

export function remoteDeniedMessage(action) {
  return action === "delete" ? REMOTE_DELETE_OFF : REMOTE_UPLOAD_OFF;
}

/**
 * Flags the file browser may show. Server lock still applies on this PC.
 * @param {{ allowDelete: boolean, allowRename: boolean, allowCreateFolder: boolean, allowUpload: boolean, maxUploadMb: number }} lock
 */
export function browserActionsFor(lock, remote, onThisPc) {
  const uploadRename = remoteActionAllowed(remote, "upload", onThisPc);
  const rename = remoteActionAllowed(remote, "rename", onThisPc);
  return {
    onThisPc: Boolean(onThisPc),
    allowDelete: Boolean(lock.allowDelete) && remoteActionAllowed(remote, "delete", onThisPc),
    allowUpload: Boolean(lock.allowUpload) && uploadRename,
    allowRename: Boolean(lock.allowRename) && rename,
    allowMove: Boolean(lock.allowRename) && remoteActionAllowed(remote, "move", onThisPc),
    allowCreateFolder: Boolean(lock.allowCreateFolder),
    maxUploadMb: lock.maxUploadMb,
  };
}
