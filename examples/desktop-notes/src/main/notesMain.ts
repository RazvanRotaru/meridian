/** The main process: owns the notes store and answers the renderer over IPC. */

import { ipcMain } from "electron";

const notes = new Map<string, string>();
const autosaveRevisions = new Map<string, number>();
const autosaveTimes = new Map<string, number>();

interface AutosaveRequest {
  id: string;
  body: string;
  revision: number;
}

/** Register every notes IPC handler the renderer can reach. */
export function registerNotesHandlers(): void {
  ipcMain.handle("notes:load", () => [...notes.entries()]);
  ipcMain.handle("notes:save", (_event, id: string, body: string) => {
    notes.set(id, body);
    return notes.size;
  });
  ipcMain.handle("notes:auto-save", (_event, request: AutosaveRequest) => {
    if (!request.id || typeof request.body !== "string" || !Number.isInteger(request.revision)) {
      throw new Error("invalid autosave request");
    }

    const savedRevision = autosaveRevisions.get(request.id) ?? 0;
    if (request.revision <= savedRevision) {
      return {
        noteId: request.id,
        revision: savedRevision,
        savedAt: autosaveTimes.get(request.id) ?? Date.now(),
      };
    }

    const savedAt = Date.now();
    notes.set(request.id, request.body);
    autosaveRevisions.set(request.id, request.revision);
    autosaveTimes.set(request.id, savedAt);
    return { noteId: request.id, revision: request.revision, savedAt };
  });
  ipcMain.on("notes:delete", (_event, id: string) => {
    notes.delete(id);
    autosaveRevisions.delete(id);
    autosaveTimes.delete(id);
  });
  // Nobody in this repo sends on this channel — a dangling entry the graph should surface.
  ipcMain.handle("notes:export", () => JSON.stringify([...notes.entries()]));
}

/** Push a change notification INTO the renderer (main → renderer direction). */
export function notifyNotesChanged(win: { webContents: { send(channel: string): void } }): void {
  win.webContents.send("notes:changed");
}
