/** Production wiring for the framework-free autosave controller. */

import { autosaveNote } from "./notesClient";
import { NoteAutosaveController, type AutosaveState } from "./noteAutosaveController";

export function createNoteAutosave(
  noteId: string,
  onState: (state: AutosaveState) => void,
): NoteAutosaveController {
  return new NoteAutosaveController(noteId, autosaveNote, onState);
}
