/**
 * Conservative service-container composition inference. Explicit registrations add a structural
 * edge without replacing the behavioural call/new edges, while merely register-shaped domain code
 * remains behavioural-only.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { validateArtifact, type ExtractionResult, type GraphArtifact } from "@meridian/core";
import { createTypeScriptExtractor } from "./index";

const SOURCE = [
  "export class EmailService {}",
  "export class AuditService {}",
  "export class TopLevelService {}",
  "export class ServiceContainer {",
  "  register(key: string, value: unknown): void {}",
  '  get<T>(): T { throw new Error("not configured"); }',
  "}",
  "export class Router {",
  "  register(key: string, value: unknown): void {}",
  '  get<T>(): T { throw new Error("no route"); }',
  "}",
  "export class BackendProviderRegistry { register(value: unknown): void {} }",
  "export function configure(container: ServiceContainer, router: Router): void {",
  '  container.register("email", EmailService);',
  '  container.register("audit", new AuditService());',
  '  router.register("route", EmailService);',
  "  router.get<EmailService>();",
  "}",
  "export function resolveEmail(container: ServiceContainer): EmailService {",
  "  return container.get<EmailService>();",
  "}",
  "const container = new ServiceContainer();",
  'container.register("top", TopLevelService);',
  "const backendProviderRegistry = new BackendProviderRegistry();",
  "backendProviderRegistry.register(new EmailService());",
  "const values = new Map<string, unknown>();",
  'values.set("email", EmailService);',
  "export class Users { register(request: unknown): void {} }",
  "export function domainAction(users: Users): void { users.register({}); }",
].join("\n");

let root: string;
let result: ExtractionResult;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "meridian-composition-"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "container.ts"), `${SOURCE}\n`);
  result = await createTypeScriptExtractor().extract({ root, include: ["src/**/*.ts"] });
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

function edges(kind: string, source: string, target: string) {
  const nameById = new Map(result.nodes.map((node) => [node.id, node.qualifiedName]));
  return result.edges.filter(
    (edge) => edge.kind === kind && nameById.get(edge.source) === source && nameById.get(edge.target) === target,
  );
}

function artifactFrom(extraction: ExtractionResult): GraphArtifact {
  return {
    schemaVersion: "1.0.0",
    generatedAt: new Date().toISOString(),
    generator: { name: "test", version: "0.0.0" },
    target: { name: "composition", root: ".", language: "typescript" },
    nodes: extraction.nodes,
    edges: extraction.edges,
  };
}

describe("explicit service-container composition", () => {
  it("emits registers from an enclosing function to resolvable registered classes", () => {
    expect(edges("registers", "configure", "EmailService")).toHaveLength(1);
    expect(edges("registers", "configure", "AuditService")).toHaveLength(1);
    expect(edges("registers", "configure", "EmailService")[0]?.callSites?.[0]).toMatchObject({
      file: "src/container.ts",
      line: 14,
      endLine: 14,
    });
    expect(edges("registers", "configure", "EmailService")[0]?.callSites?.[0]?.endCol)
      .toBeGreaterThan(edges("registers", "configure", "EmailService")[0]?.callSites?.[0]?.col ?? 0);
  });

  it("uses the module as owner for a top-level registration", () => {
    expect(edges("registers", "src/container.ts", "TopLevelService")).toHaveLength(1);
    expect(edges("registers", "src/container.ts", "EmailService")).toHaveLength(1);
  });

  it("does not classify arbitrary register methods, one-argument domain calls, or Map.set", () => {
    expect(edges("registers", "configure", "EmailService")).toHaveLength(1);
    expect(result.edges.filter((edge) => edge.kind === "registers")).toHaveLength(4);
  });

  it("preserves the ordinary call and instantiation evidence", () => {
    expect(edges("calls", "configure", "ServiceContainer.register")).toHaveLength(1);
    expect(edges("instantiates", "configure", "AuditService")).toHaveLength(1);
  });

  it("emits injects for an explicit generic container get while preserving call/reference evidence", () => {
    expect(edges("injects", "resolveEmail", "EmailService")).toHaveLength(1);
    expect(result.edges.filter((edge) => edge.kind === "injects")).toHaveLength(1);
    expect(edges("calls", "resolveEmail", "ServiceContainer.get")).toHaveLength(1);
    expect(edges("references", "resolveEmail", "EmailService").length).toBeGreaterThan(0);
  });

  it("uses registered composition vocabulary without validation warnings", () => {
    const validation = validateArtifact(artifactFrom(result));
    expect(validation.ok).toBe(true);
    expect(validation.warnings).toEqual([]);
  });
});
