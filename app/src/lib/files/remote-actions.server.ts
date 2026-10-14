import { resolve } from "node:path";
import { isPcAdminRequest } from "./host-request.server";
import {
  readRemoteActionsFile,
  remoteActionAllowed,
  remoteDeniedMessage,
  writeRemoteActionsFile,
} from "./remote-actions.mjs";
import { resolveDataDir } from "./settings.server";

export type RemoteActionName = "delete" | "upload" | "rename" | "move";

export function resolveRemoteActionsFile(): string {
  return resolve(resolveDataDir(), "remote-actions.json");
}

export function readRemoteActions() {
  return readRemoteActionsFile(resolveRemoteActionsFile());
}

export function writeRemoteActions(input: {
  allowDeleteFromOtherDevices: boolean;
  allowUploadRenameFromOtherDevices: boolean;
}) {
  return writeRemoteActionsFile(resolveRemoteActionsFile(), input);
}

export function assertRemoteAction(action: RemoteActionName): void {
  if (remoteActionAllowed(readRemoteActions(), action, isPcAdminRequest())) return;
  const err = new Error(remoteDeniedMessage(action));
  Object.assign(err, { status: 403, statusCode: 403 });
  throw err;
}
