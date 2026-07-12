import { describe, expect, it } from "vitest";
import type { GraphNode } from "@meridian/core";
import { isSourceBackedNode } from "./sourceBackedNode";

function node(id: string, kind: string, file: string): GraphNode {
  return {
    id,
    kind,
    qualifiedName: id,
    displayName: id,
    parentId: null,
    location: { file, startLine: 1 },
  };
}

describe("isSourceBackedNode", () => {
  it.each([
    ["TypeScript module", node("ts:src/app.ts", "module", "src/app.ts")],
    ["TypeScript member", node("ts:src/app.ts#run", "function", "src/app.ts")],
    ["Python member", node("py:orders.service#run", "function", "orders/service.py")],
    ["linked source member", node("ts:web/src/app.ts#run", "method", "web/src/app.ts")],
    ["extensionless source", node("go:cmd/tool#main", "function", "cmd/tool")],
    ["open-vocabulary source", node("ruby:lib/job.rb#call", "singletonMethod", "lib/job.rb")],
    ["edge evidence", node("edge-evidence:calls%40a%7Cb:0", "method", "src/app.ts")],
  ])("allows %s", (_label, candidate) => {
    expect(isSourceBackedNode(candidate)).toBe(true);
  });

  it.each([
    ["TypeScript directory", node("ts:src/services", "package", "src/services")],
    ["Python dotted package", node("py:orders.repository", "package", "orders.repository")],
    ["linked system", node("sys:web", "system", "web")],
    ["external container", node("ext:__external__", "external", "")],
    ["file-shaped external leaf", node("ext:typescript/lib.es5.d.ts#Error", "external", "typescript/lib.es5.d.ts")],
    ["unresolved boundary", node("unresolved:?", "unresolved", "?")],
    ["IPC channel", node("ipc:http/GET+/orders", "channel", "(http)")],
    ["synthetic kind with source-like id", node("ts:src/external.ts", "external", "src/external.ts")],
    ["source kind with boundary id", node("ext:src/local.ts#run", "function", "src/local.ts")],
    ["blank source path", node("ts:src/blank.ts", "module", "   ")],
  ])("rejects %s", (_label, candidate) => {
    expect(isSourceBackedNode(candidate)).toBe(false);
  });

  it("rejects an absent node", () => {
    expect(isSourceBackedNode(undefined)).toBe(false);
    expect(isSourceBackedNode(null)).toBe(false);
  });
});
