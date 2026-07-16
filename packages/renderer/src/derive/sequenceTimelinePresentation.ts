/**
 * Quiet visual projection for the sequence diagram.
 *
 * The semantic model stays complete for its ordered screen-reader transcript. This projection
 * removes redundant visual-detail rows, compacts the remaining row numbers, and remaps structural
 * boundaries so the diagram keeps its branch/loop meaning without leaving empty gaps.
 */

import type {
  SequenceFrame,
  SequenceRow,
  SequenceTimelineModel,
} from "./sequenceTimelineModel";

export function buildSequencePresentation(model: SequenceTimelineModel): SequenceTimelineModel {
  const sourceRows = model.rows.filter((row) => row.visualRole === "primary");
  const displayRowBySource = new Map<number, number>();
  const rows = sourceRows.map((row, displayRow): SequenceRow => {
    displayRowBySource.set(row.row, displayRow);
    return { ...row, row: displayRow };
  });
  const frames = model.frames.flatMap((frame): SequenceFrame[] => {
    const visible = sourceRows.filter((row) => row.row >= frame.startRow && row.row <= frame.endRow);
    const first = visible[0];
    const last = visible.at(-1);
    if (!first || !last) return [];

    const startRow = displayRowBySource.get(first.row);
    const endRow = displayRowBySource.get(last.row);
    if (startRow === undefined || endRow === undefined) return [];

    const separators = frame.separators.flatMap((separator) => {
      const nextVisible = visible.find((row) => row.row >= separator.row);
      if (!nextVisible) return [];
      const row = displayRowBySource.get(nextVisible.row);
      return row === undefined ? [] : [{ ...separator, row }];
    });
    return [{ ...frame, startRow, endRow, separators }];
  });

  return { ...model, rows, frames };
}
