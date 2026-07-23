/**
 * `POST /api/pick-folder` — pop the OS folder dialog on the machine running `web` and return the
 * absolute path the user chose. `{ path }` on a pick, `{ cancelled: true }` when dismissed, and
 * `{ unavailable: true }` when no native picker can run (headless box, missing binary) — the landing
 * page then quietly leaves the reader on the type-a-path field rather than surfacing an error.
 */

import type { ServerResponse } from "node:http";
import { sendJson } from "./http-response";
import { FolderDialogUnavailable, pickFolder } from "./folder-dialog";

export async function handlePickFolder(
  response: ServerResponse,
  signal: AbortSignal,
  picker: typeof pickFolder = pickFolder,
): Promise<void> {
  try {
    const path = await picker({ signal });
    sendJson(response, 200, path ? { path } : { cancelled: true });
  } catch (error) {
    if (error instanceof FolderDialogUnavailable) {
      sendJson(response, 200, { unavailable: true });
      return;
    }
    throw error;
  }
}
