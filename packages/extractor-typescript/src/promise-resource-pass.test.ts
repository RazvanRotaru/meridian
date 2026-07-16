import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { LogicFlows } from "@meridian/core";
import { createTypeScriptExtractor } from "./index";
import {
  AWAITS_PROMISE_KIND,
  CREATES_PROMISE_KIND,
  PROMISE_RESOURCE_KIND,
  REJECTS_PROMISE_KIND,
  RESOLVES_PROMISE_KIND,
  RETURNS_PROMISE_KIND,
} from "./promise-resource-pass";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

async function extractFixture() {
  const root = join(REPO, "packages", "extractor-typescript", "fixtures", "promise-resources");
  return createTypeScriptExtractor().extract({ root, project: join(root, "tsconfig.json") });
}

async function extractShadowedFixture() {
  const root = join(REPO, "packages", "extractor-typescript", "fixtures", "promise-shadowed");
  return createTypeScriptExtractor().extract({ root, project: join(root, "tsconfig.json") });
}

describe("Promise resource pass", () => {
  it("joins a stored Promise to its creator, return aliases, awaiters, and settlers", async () => {
    const result = await extractFixture();
    const resources = result.nodes.filter(
      (node) => node.kind === PROMISE_RESOURCE_KIND && node.displayName === "registrationReady",
    );
    expect(resources).toHaveLength(1);
    expect(resources[0]).toMatchObject({ displayName: "registrationReady", tags: ["resource", "promise"] });

    const target = resources[0].id;
    const edges = result.edges.filter((edge) => edge.target === target);
    expect(edges.map((edge) => edge.kind).sort()).toEqual([
      AWAITS_PROMISE_KIND,
      CREATES_PROMISE_KIND,
      REJECTS_PROMISE_KIND,
      RESOLVES_PROMISE_KIND,
      RETURNS_PROMISE_KIND,
      RETURNS_PROMISE_KIND,
    ].sort());
    expect(edges.find((edge) => edge.kind === RESOLVES_PROMISE_KIND)?.source).toContain("RegistrationGate.acknowledge");
    expect(edges.find((edge) => edge.kind === REJECTS_PROMISE_KIND)?.source).toContain("RegistrationGate.acknowledge");
    expect(edges.find((edge) => edge.kind === AWAITS_PROMISE_KIND)?.source).toContain("bootstrap");
  });

  it("keeps a return-only Promise barrier chartable and drops unobserved Promise nodes", async () => {
    const result = await extractFixture();
    const flows = result.flows as LogicFlows;
    const waitId = Object.keys(flows).find((id) => id.includes("waitForRegistration"));
    expect(waitId).toBeTruthy();
    expect(flows[waitId!]).toEqual([expect.objectContaining({ kind: "exit", variant: "return" })]);
    expect(result.nodes.some((node) => node.kind === PROMISE_RESOURCE_KIND && node.displayName === "ignored")).toBe(false);
  });

  it("keeps allocation sites distinct and refuses to correlate an ambiguously reassigned field", async () => {
    const result = await extractFixture();
    const owner = result.nodes.find((node) => node.kind === "class" && node.displayName === "ReassignedGate");
    expect(owner).toBeTruthy();
    const resources = result.nodes.filter(
      (node) => node.kind === PROMISE_RESOURCE_KIND && node.parentId === owner!.id && node.displayName === "ready",
    );

    expect(resources).toHaveLength(2);
    expect(new Set(resources.map((resource) => resource.id))).toHaveLength(2);
    for (const resource of resources) {
      const kinds = result.edges.filter((edge) => edge.target === resource.id).map((edge) => edge.kind);
      expect(kinds).toContain(CREATES_PROMISE_KIND);
      expect(kinds).toContain(RESOLVES_PROMISE_KIND);
      expect(kinds).not.toContain(RETURNS_PROMISE_KIND);
      expect(kinds).not.toContain(AWAITS_PROMISE_KIND);
    }
    expect(Object.keys(result.flows ?? {}).some((id) => id.includes("ReassignedGate.wait"))).toBe(false);
  });

  it("fails closed when a Promise storage location has an unknown later overwrite", async () => {
    const result = await extractFixture();
    const owner = result.nodes.find((node) => node.kind === "class" && node.displayName === "MutableOverwriteGate");
    const resource = result.nodes.find(
      (node) => node.kind === PROMISE_RESOURCE_KIND && node.parentId === owner?.id && node.displayName === "ready",
    );
    expect(resource).toBeTruthy();
    const kinds = result.edges.filter((edge) => edge.target === resource!.id).map((edge) => edge.kind);
    expect(kinds).toContain(RESOLVES_PROMISE_KIND);
    expect(kinds).not.toContain(RETURNS_PROMISE_KIND);
    expect(kinds).not.toContain(AWAITS_PROMISE_KIND);
    expect(Object.keys(result.flows ?? {}).some((id) => id.includes("MutableOverwriteGate.wait"))).toBe(false);
  });

  it("attributes a named nested callback's Promise use to that callback, not its outer method", async () => {
    const result = await extractFixture();
    const owner = result.nodes.find((node) => node.kind === "class" && node.displayName === "NestedCallbackGate");
    const resource = result.nodes.find(
      (node) => node.kind === PROMISE_RESOURCE_KIND && node.parentId === owner?.id && node.displayName === "ready",
    );
    expect(resource).toBeTruthy();
    const edges = result.edges.filter((edge) => edge.target === resource!.id);
    expect(edges.some((edge) => edge.kind === AWAITS_PROMISE_KIND)).toBe(true);
    // Returning a Promise from an async callback adopts it into the callback's own Promise; it is
    // not an alias return of the stored resource.
    expect(edges.some((edge) => edge.kind === RETURNS_PROMISE_KIND)).toBe(false);
    expect(edges.some((edge) => edge.source.endsWith("#NestedCallbackGate.inspect"))).toBe(false);
    expect(edges.some((edge) => edge.source.includes("NestedCallbackGate.inspect.unindexedCallback"))).toBe(true);
  });

  it("recognizes the standard Promise through globalThis", async () => {
    const result = await extractFixture();
    const owner = result.nodes.find((node) => node.kind === "class" && node.displayName === "ExplicitGlobalGate");
    const resource = result.nodes.find(
      (node) => node.kind === PROMISE_RESOURCE_KIND && node.parentId === owner?.id && node.displayName === "ready",
    );
    expect(resource).toBeTruthy();
    const kinds = result.edges.filter((edge) => edge.target === resource!.id).map((edge) => edge.kind);
    expect(kinds).toContain(RETURNS_PROMISE_KIND);
    expect(kinds).toContain(AWAITS_PROMISE_KIND);
    expect(kinds).toContain(RESOLVES_PROMISE_KIND);
  });

  it("rejects a Promise symbol supplied by an arbitrary declaration file", async () => {
    const result = await extractShadowedFixture();
    expect(result.nodes.some((node) => node.kind === PROMISE_RESOURCE_KIND)).toBe(false);
    expect(result.edges.some((edge) => edge.kind === CREATES_PROMISE_KIND)).toBe(false);
  });
});
