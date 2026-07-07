/** The main process: owns the notes store and answers the renderer over IPC. */

import { ipcMain } from "electron";

const notes = new Map<string, string>();

/** Register every notes IPC handler the renderer can reach. */
export function registerNotesHandlers(): void {
  ipcMain.handle("notes:load", () => [...notes.entries()]);
  ipcMain.handle("notes:save", (_event, id: string, body: string) => {
    notes.set(id, body);
    return notes.size;
  });
  ipcMain.on("notes:delete", (_event, id: string) => {
    notes.delete(id);
  });
  // Nobody in this repo sends on this channel — a dangling entry the graph should surface.
  ipcMain.handle("notes:export", () => JSON.stringify([...notes.entries()]));
}

/** Push a change notification INTO the renderer (main → renderer direction). */
export function notifyNotesChanged(win: { webContents: { send(channel: string): void } }): void {
  win.webContents.send("notes:changed");
}
