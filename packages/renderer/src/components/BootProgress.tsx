import type { BootProgressStage, BootProgressUpdate } from "../boot/bootProgress";
import { PrReviewProgressView } from "./PrReviewProgressView";

export interface BootProgressProps {
  progress: BootProgressUpdate;
}

/**
 * The store does not exist during boot, so this small surface renders directly from bootstrap
 * progress. It names the real blocking operation instead of leaving a PR restore behind one
 * undifferentiated "Loading blueprint" message.
 */
export function BootProgress({ progress }: BootProgressProps) {
  if (progress.reviewProgress !== null) {
    return (
      <main style={WRAP}>
        <section style={CARD}>
          <div style={EYEBROW}>MERIDIAN</div>
          <PrReviewProgressView progress={progress.reviewProgress} variant="boot" />
          <p style={REVIEW_NOTE}>
            Cold revisions can take several minutes. The review opens only after the exact HEAD and
            merge-base graphs are ready.
          </p>
        </section>
      </main>
    );
  }
  const detail = STAGE_COPY[progress.stage];
  const phase = phaseFor(progress.stage);
  return (
    <main style={WRAP}>
      <section style={CARD} aria-labelledby="mrd-boot-title">
        <div style={EYEBROW}>MERIDIAN</div>
        <h1 id="mrd-boot-title" style={TITLE}>
          Opening blueprint
        </h1>
        <div role="status" aria-live="polite" aria-atomic="true" style={STATUS}>
          <span aria-hidden="true" style={SPINNER} />
          <span>
            <strong style={STATUS_TITLE}>{detail.title}</strong>
            <span style={STATUS_DETAIL}>{detail.detail}</span>
          </span>
        </div>
        <ol aria-label="Loading progress" style={PHASES}>
          {phases(false).map((entry, index) => {
            const state = index < phase ? "done" : index === phase ? "active" : "pending";
            return (
              <li
                key={entry}
                data-state={state}
                aria-current={state === "active" ? "step" : undefined}
                style={PHASE}
              >
                <span aria-hidden="true" style={phaseDot(state)} />
                <span style={phaseLabel(state)}>{entry}</span>
              </li>
            );
          })}
        </ol>
      </section>
    </main>
  );
}

const STAGE_COPY: Record<BootProgressStage, { title: string; detail: string }> = {
  graph: {
    title: "Loading repository graph…",
    detail: "Downloading and decoding the selected repository artifact.",
  },
  index: {
    title: "Indexing graph nodes and edges…",
    detail: "Building the lookup structures used by every blueprint surface.",
  },
  services: {
    title: "Starting blueprint services…",
    detail: "Connecting source, telemetry, and review capabilities.",
  },
  "initial-layout": {
    title: "Arranging the initial view…",
    detail: "Preparing the repository surface before restoring navigation.",
  },
  "review-details": {
    title: "Loading pull request details…",
    detail: "Resolving the exact PR revision and changed-file inventory.",
  },
  "review-resolve": {
    title: "Resolving exact PR revisions…",
    detail: "Checking live HEAD and base refs plus verified graph caches.",
  },
  "review-clone": {
    title: "Cloning the repository…",
    detail: "Preparing an isolated workspace for this pull request.",
  },
  "review-checkout": {
    title: "Fetching PR HEAD and merge base…",
    detail: "Checking out the exact revisions that Git compares.",
  },
  "review-extract": {
    title: "Extracting exact revision graphs…",
    detail: "Building the HEAD and merge-base graph artifacts.",
  },
  "review-extract-head": {
    title: "Extracting the PR HEAD graph…",
    detail: "Building the graph for the exact pull request commit.",
  },
  "review-reuse-head": {
    title: "Reusing the verified PR HEAD graph…",
    detail: "The immutable pull request revision is already available.",
  },
  "review-extract-merge-base": {
    title: "Extracting the merge-base graph…",
    detail: "Building the exact comparison revision used by Git.",
  },
  "review-reuse-merge-base": {
    title: "Reusing the verified merge-base graph…",
    detail: "The immutable comparison revision is already available.",
  },
  "review-artifacts": {
    title: "Loading and indexing review graphs…",
    detail: "Reading the prepared HEAD and merge-base artifacts into the renderer.",
  },
  "review-projection": {
    title: "Building the review blueprint…",
    detail: "Projecting changed files, call sites, flows, and deletions onto the exact revisions.",
  },
};

function phaseFor(stage: BootProgressStage): number {
  if (stage === "graph" || stage === "index" || stage === "services" || stage === "initial-layout") {
    return 0;
  }
  if (stage === "review-projection") {
    return 2;
  }
  return 1;
}

function phases(review: boolean): readonly string[] {
  return review
    ? ["Load repository", "Prepare exact revisions", "Open review"]
    : ["Load repository"];
}

type PhaseState = "done" | "active" | "pending";

function phaseDot(state: PhaseState): React.CSSProperties {
  return {
    width: 9,
    height: 9,
    borderRadius: 999,
    flexShrink: 0,
    background: state === "done" ? "#56C271" : state === "active" ? "#388BFD" : "#2A2F37",
    boxShadow: state === "active" ? "0 0 0 4px rgba(56,139,253,0.18)" : "none",
  };
}

function phaseLabel(state: PhaseState): React.CSSProperties {
  return {
    color: state === "pending" ? "#6E7681" : "#C9D1D9",
    fontWeight: state === "active" ? 650 : 500,
  };
}

const WRAP: React.CSSProperties = {
  minHeight: "100%",
  display: "grid",
  placeItems: "center",
  padding: 24,
  boxSizing: "border-box",
  background: "#0E1116",
  color: "#F0F6FC",
};
const CARD: React.CSSProperties = {
  width: "min(520px, 100%)",
  border: "1px solid #2A2F37",
  borderRadius: 12,
  background: "#0B0F14",
  padding: 24,
  boxShadow: "0 18px 50px rgba(0,0,0,0.22)",
};
const EYEBROW: React.CSSProperties = {
  color: "#7DD3FC",
  fontSize: 11,
  fontWeight: 750,
  letterSpacing: "0.16em",
};
const TITLE: React.CSSProperties = {
  margin: "7px 0 20px",
  fontSize: 20,
  lineHeight: "28px",
  fontWeight: 700,
};
const STATUS: React.CSSProperties = {
  minHeight: 62,
  display: "flex",
  alignItems: "flex-start",
  gap: 12,
  border: "1px solid #21262D",
  borderRadius: 9,
  background: "#11161D",
  padding: 14,
};
const SPINNER: React.CSSProperties = {
  width: 10,
  height: 10,
  marginTop: 3,
  borderRadius: 999,
  background: "#388BFD",
  boxShadow: "0 0 0 4px rgba(56,139,253,0.18)",
  flexShrink: 0,
};
const STATUS_TITLE: React.CSSProperties = {
  display: "block",
  color: "#E6EDF3",
  fontSize: 13.5,
  lineHeight: "19px",
};
const STATUS_DETAIL: React.CSSProperties = {
  display: "block",
  marginTop: 3,
  color: "#8B949E",
  fontSize: 12,
  lineHeight: "18px",
};
const PHASES: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 20,
  listStyle: "none",
  margin: "20px 0 0",
  padding: 0,
};
const PHASE: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  minWidth: 0,
  fontSize: 11.5,
};
const REVIEW_NOTE: React.CSSProperties = {
  margin: "18px 0 0",
  color: "#6E7681",
  fontSize: 11.5,
  lineHeight: "17px",
};
