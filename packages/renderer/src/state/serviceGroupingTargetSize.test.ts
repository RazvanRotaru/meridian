import { describe, expect, it } from "vitest";
import type { GraphArtifact } from "@meridian/core";
import { buildGraphIndex } from "../graph/graphIndex";
import { createBlueprintStore } from "./store";
import { decodeNavState } from "./urlState";
import { structuralState } from "./urlSync";
import {
  DEFAULT_SERVICE_GROUPING_TARGET_SIZE,
  SERVICE_GROUPING_TARGET_SIZES,
  type ServiceGroupingTargetSize,
} from "./serviceGroupingTargetSize";

const ARTIFACT = {
  schemaVersion: "0.1",
  generatedAt: "2026-07-11T00:00:00Z",
  target: { name: "target-size", root: ".", language: "typescript", entryModules: [] },
  nodes: [],
  edges: [],
} as unknown as GraphArtifact;

function freshStore() {
  return createBlueprintStore({
    artifact: ARTIFACT,
    index: buildGraphIndex(ARTIFACT),
    provider: null,
    hasOverlay: false,
    sourceUrl: null,
    prsUrl: "",
    prFilesUrl: "",
    prReviewUrl: "",
  });
}

describe("Service grouping target size", () => {
  it("starts at the documented default from the supported option set", () => {
    const store = freshStore();
    expect(store.getState().serviceGroupingTargetSize).toBe(DEFAULT_SERVICE_GROUPING_TARGET_SIZE);
    expect(SERVICE_GROUPING_TARGET_SIZES).toEqual([6, 8, 12, 16, 24, 32]);
  });

  it("accepts a supported target and ignores an unsupported runtime value", () => {
    const store = freshStore();
    store.getState().setServiceGroupingTargetSize(24);
    expect(store.getState().serviceGroupingTargetSize).toBe(24);

    store.getState().setServiceGroupingTargetSize(13 as ServiceGroupingTargetSize);
    expect(store.getState().serviceGroupingTargetSize).toBe(24);
  });

  it("restores a URL value and resets an absent value back to 12", () => {
    const restored = structuralState(decodeNavState(new URLSearchParams("view=call&sgsize=24")));
    expect(restored).toHaveProperty("serviceGroupingTargetSize", 24);

    const reset = structuralState(decodeNavState(new URLSearchParams("view=call")));
    expect(reset).toHaveProperty("serviceGroupingTargetSize", DEFAULT_SERVICE_GROUPING_TARGET_SIZE);
  });
});
