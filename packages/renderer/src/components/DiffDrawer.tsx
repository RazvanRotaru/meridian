/**
 * The diff drawer: a bottom panel showing the REAL unified diff behind the selected changed
 * node, streamed per file from the local serve process (`/api/file-diff`) and anchored to the
 * node's source span. `←/→` buttons and `j`/`k` step through every changed node on screen in
 * layout order — reviewing a range becomes a walk across the map. `Esc` closes.
 *
 * Fetches are cached per file for the session; the drawer never blocks the canvas (it
 * overlays the bottom, the graph stays interactive above it).
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useBlueprint, useBlueprintActions } from "../state/StoreContext";
import { changeStops } from "../state/store";

const diffCache = new Map<string, Promise<string>>();

export function DiffDrawer() {
  const diffNodeId = useBlueprint((state) => state.diffNodeId);
  const node = useBlueprint((state) => (state.diffNodeId ? state.index.nodesById.get(state.diffNodeId) : undefined));
  const change = useBlueprint((state) => state.change);
  const fileDiffUrl = useBlueprint((state) => state.fileDiffUrl);
  const index = useBlueprint((state) => state.index);
  const stops = useMemo(() => (change ? changeStops(change, index) : []), [change, index]);
  const stopPosition = diffNodeId ? stops.indexOf(diffNodeId) : -1;
  const { closeDiff, stepDiff } = useBlueprintActions();
  const [diffText, setDiffText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  const file = node?.location?.file ?? null;
  const fileChange = file && change ? change.files[file] : undefined;

  useEffect(() => {
    if (!file || !fileDiffUrl) {
      return;
    }
    let cancelled = false;
    setDiffText(null);
    setError(null);
    fetchDiff(fileDiffUrl, file)
      .then((text) => {
        if (!cancelled) {
          setDiffText(text);
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : "failed to load diff");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [file, fileDiffUrl]);

  // j/k step, Esc closes — active only while the drawer is open.
  useEffect(() => {
    if (!diffNodeId) {
      return;
    }
    const onKey = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target)) {
        return;
      }
      if (event.key === "Escape") {
        closeDiff();
      } else if (event.key === "j") {
        stepDiff(1);
      } else if (event.key === "k") {
        stepDiff(-1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [diffNodeId, closeDiff, stepDiff]);

  const lines = useMemo(() => (diffText ? parseDiffLines(diffText) : []), [diffText]);

  // Anchor the scroll at the node's own span once the diff is in.
  useEffect(() => {
    if (!lines.length || !node?.location || !bodyRef.current) {
      return;
    }
    const target = bodyRef.current.querySelector(`[data-anchor="true"]`);
    if (target) {
      target.scrollIntoView({ block: "start" });
    }
  }, [lines, node]);

  if (!diffNodeId || !node || !file) {
    return null;
  }
  const anchorLine = node.location?.startLine ?? 1;
  return (
    <div style={DRAWER_STYLE}>
      <div style={HEADER_STYLE}>
        <span style={DIFF_LABEL_STYLE}>DIFF</span>
        <code style={FILE_STYLE}>{file}</code>
        {node.kind !== "module" ? <code style={SYMBOL_STYLE}>ƒ {node.displayName}</code> : null}
        {fileChange ? (
          <span style={STATS_STYLE}>
            <span style={{ color: "#56C271" }}>+{fileChange.additions}</span>{" "}
            <span style={{ color: "#E5534B" }}>−{fileChange.deletions}</span>
          </span>
        ) : null}
        <span style={STEPPER_STYLE}>
          <button type="button" style={STEP_BUTTON_STYLE} onClick={() => stepDiff(-1)} aria-label="Previous change (k)">
            ◀
          </button>
          <span style={COUNT_STYLE}>
            {stopPosition === -1 ? stops.length : `${stopPosition + 1} / ${stops.length}`} changed · j / k
          </span>
          <button type="button" style={STEP_BUTTON_STYLE} onClick={() => stepDiff(1)} aria-label="Next change (j)">
            ▶
          </button>
        </span>
        <button type="button" style={CLOSE_STYLE} onClick={closeDiff} aria-label="Close diff (Esc)">
          ×
        </button>
      </div>
      <div ref={bodyRef} style={BODY_STYLE}>
        {error ? <div style={ERROR_STYLE}>{error}</div> : null}
        {!error && diffText === null ? <div style={LOADING_STYLE}>loading diff…</div> : null}
        {lines.map((line, index) => (
          <div
            key={index}
            style={lineStyle(line.kind)}
            data-anchor={line.newLine !== null && line.newLine >= anchorLine ? "true" : undefined}
          >
            {line.text || " "}
          </div>
        ))}
      </div>
    </div>
  );
}

function fetchDiff(endpoint: string, file: string): Promise<string> {
  const cached = diffCache.get(file);
  if (cached) {
    return cached;
  }
  const request = fetch(`${endpoint}?file=${encodeURIComponent(file)}`).then(async (response) => {
    if (!response.ok) {
      throw new Error(`diff unavailable (${response.status})`);
    }
    return response.text();
  });
  diffCache.set(file, request);
  request.catch(() => diffCache.delete(file));
  return request;
}

interface DiffLine {
  kind: "meta" | "hunk" | "add" | "del" | "context";
  text: string;
  /** New-file line number when this line exists on the new side (context/add). */
  newLine: number | null;
}

/** Classify unified-diff lines and track new-side line numbers for span anchoring. */
function parseDiffLines(diff: string): DiffLine[] {
  const lines: DiffLine[] = [];
  let newLine = 0;
  for (const raw of diff.split("\n")) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      newLine = Number(hunk[1]);
      lines.push({ kind: "hunk", text: raw, newLine });
      continue;
    }
    if (/^(diff |index |--- |\+\+\+ |new file|deleted file|similarity|rename )/.test(raw)) {
      lines.push({ kind: "meta", text: raw, newLine: null });
      continue;
    }
    if (raw.startsWith("+")) {
      lines.push({ kind: "add", text: raw, newLine });
      newLine += 1;
      continue;
    }
    if (raw.startsWith("-")) {
      lines.push({ kind: "del", text: raw, newLine: null });
      continue;
    }
    lines.push({ kind: "context", text: raw, newLine });
    newLine += 1;
  }
  return lines;
}

function isTypingTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.tagName === "INPUT" || target.tagName === "TEXTAREA");
}

function lineStyle(kind: DiffLine["kind"]): React.CSSProperties {
  const base: React.CSSProperties = {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: 11,
    lineHeight: "17px",
    whiteSpace: "pre",
    padding: "0 12px",
  };
  switch (kind) {
    case "hunk":
      return { ...base, color: "#61DAFB", background: "#101820", padding: "2px 12px" };
    case "meta":
      return { ...base, color: "#7C8696" };
    case "add":
      return { ...base, color: "#7CE8A4", background: "rgba(86,194,113,0.08)" };
    case "del":
      return { ...base, color: "#F19A94", background: "rgba(229,83,75,0.07)" };
    default:
      return { ...base, color: "#9AA4B2" };
  }
}

const DRAWER_STYLE: React.CSSProperties = {
  position: "fixed",
  left: 0,
  right: 0,
  bottom: 0,
  height: "40vh",
  display: "flex",
  flexDirection: "column",
  background: "rgba(11,14,19,0.97)",
  borderTop: "1px solid #2A2F37",
  boxShadow: "0 -8px 24px rgba(0,0,0,0.45)",
  zIndex: 20,
};
const HEADER_STYLE: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "8px 14px",
  borderBottom: "1px solid #1E232C",
  color: "#E6EDF3",
};
const DIFF_LABEL_STYLE: React.CSSProperties = {
  fontSize: 9,
  fontWeight: 700,
  letterSpacing: 0.8,
  color: "#7C8696",
};
const FILE_STYLE: React.CSSProperties = {
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  fontSize: 12,
  color: "#E6EDF3",
};
const SYMBOL_STYLE: React.CSSProperties = {
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  fontSize: 11,
  color: "#4EE1C4",
};
const STATS_STYLE: React.CSSProperties = { fontSize: 11, fontWeight: 700, fontVariantNumeric: "tabular-nums" };
const STEPPER_STYLE: React.CSSProperties = { marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 };
const STEP_BUTTON_STYLE: React.CSSProperties = {
  background: "#1A1F27",
  color: "#C9D3E0",
  border: "1px solid #2A2F37",
  borderRadius: 6,
  padding: "2px 8px",
  fontSize: 10,
  cursor: "pointer",
};
const COUNT_STYLE: React.CSSProperties = { fontSize: 10, color: "#7C8696" };
const CLOSE_STYLE: React.CSSProperties = {
  border: "none",
  background: "transparent",
  color: "#9AA4B2",
  fontSize: 18,
  cursor: "pointer",
  padding: "0 2px",
};
const BODY_STYLE: React.CSSProperties = { overflow: "auto", flex: "1 1 auto", paddingBottom: 8 };
const ERROR_STYLE: React.CSSProperties = { color: "#F19A94", padding: 14, fontSize: 12 };
const LOADING_STYLE: React.CSSProperties = { color: "#7C8696", padding: 14, fontSize: 12 };
