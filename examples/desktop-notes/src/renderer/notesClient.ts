/** The renderer process: talks to the main process ONLY through the notes IPC channels. */

import { ipcRenderer } from "electron";

export async function loadNotes(): Promise<Array<[string, string]>> {
  return ipcRenderer.invoke("notes:load");
}

export async function saveNote(id: string, body: string): Promise<number> {
  return ipcRenderer.invoke("notes:save", id, body);
}

export interface AutosaveReceipt {
  noteId: string;
  revision: number;
  savedAt: number;
}

/** Persist one renderer revision without blocking the editor's typing loop. */
export async function autosaveNote(id: string, body: string, revision: number): Promise<AutosaveReceipt> {
  return ipcRenderer.invoke("notes:autosave", { id, body, revision });
}

export function deleteNote(id: string): void {
  ipcRenderer.send("notes:delete", id);
}

/** A dynamic channel: statically unknowable, so it must surface as a dynamic port, never a guess. */
export function sendOn(channel: string): void {
  ipcRenderer.send(channel, "ping");
}

export function onNotesChanged(callback: () => void): void {
  ipcRenderer.on("notes:changed", callback);
}
