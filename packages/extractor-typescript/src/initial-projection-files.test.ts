import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  scanTypeScriptProjectionTopology,
  selectInitialTypeScriptProjectionFiles,
} from "./initial-projection-files";
import { absoluteRoot } from "./paths";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(files: Record<string, string>, packageJson?: object): string {
  const root = absoluteRoot(mkdtempSync(join(tmpdir(), "meridian-initial-projection-")));
  roots.push(root);
  if (packageJson !== undefined) write(root, "package.json", JSON.stringify(packageJson));
  for (const [path, source] of Object.entries(files)) write(root, path, source);
  return root;
}

function write(root: string, relativePath: string, source: string): void {
  const path = join(root, relativePath);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, source);
}

describe("selectInitialTypeScriptProjectionFiles module adjacency", () => {
  it("finds incoming, outgoing, re-export, and literal dynamic-import neighbours", () => {
    const root = fixture({
      "src/seed.ts": [
        'import "./outgoing";',
        'export { reexported } from "./reexport";',
        'export const lazy = () => import("./dynamic");',
        'export const computed = (name: string) => import("./" + name);',
      ].join("\n"),
      "src/outgoing.ts": "export const outgoing = true;\n",
      "src/reexport.ts": "export const reexported = true;\n",
      "src/dynamic.ts": "export const dynamic = true;\n",
      "src/incoming.ts": 'import { lazy } from "./seed"; export { lazy };\n',
      "src/unrelated.ts": "export const unrelated = true;\n",
    });

    expect(selectInitialTypeScriptProjectionFiles({ root, seeds: ["src/seed.ts"], depth: 1 })).toEqual({
      files: [
        "src/dynamic.ts",
        "src/incoming.ts",
        "src/outgoing.ts",
        "src/reexport.ts",
        "src/seed.ts",
      ],
      seeds: ["src/seed.ts"],
      frontier: [],
    });
  });

  it("bounds cycles and disconnected components at the requested depth with a truthful frontier", () => {
    const root = fixture({
      "src/seed.ts": 'import "./a";\n',
      "src/a.ts": 'import "./b";\n',
      "src/b.ts": 'import "./seed"; import "./c";\n',
      "src/c.ts": "export const c = true;\n",
      "src/disconnected.ts": "export const nope = true;\n",
    });

    expect(selectInitialTypeScriptProjectionFiles({ root, seeds: ["src/seed.ts"], depth: 0 })).toEqual({
      files: ["src/seed.ts"],
      seeds: ["src/seed.ts"],
      frontier: ["src/seed.ts"],
    });
    expect(selectInitialTypeScriptProjectionFiles({ root, seeds: ["src/seed.ts"], depth: 1 })).toEqual({
      files: ["src/a.ts", "src/b.ts", "src/seed.ts"],
      seeds: ["src/seed.ts"],
      frontier: ["src/b.ts"],
    });
    expect(selectInitialTypeScriptProjectionFiles({ root, seeds: ["src/seed.ts"], depth: 2 })).toEqual({
      files: ["src/a.ts", "src/b.ts", "src/c.ts", "src/seed.ts"],
      seeds: ["src/seed.ts"],
      frontier: [],
    });
  });

  it("resolves workspace package aliases and tsconfig path aliases to source", () => {
    const root = fixture({
      "packages/app/package.json": JSON.stringify({ name: "@scope/app" }),
      "packages/app/src/index.ts": [
        'import { shared } from "@scope/shared";',
        'import { local } from "@local/value";',
        "export { shared, local };",
      ].join("\n"),
      "packages/app/src/local/value.ts": "export const local = true;\n",
      "packages/app/tsconfig.json": JSON.stringify({
        compilerOptions: { baseUrl: ".", paths: { "@local/*": ["src/local/*"] } },
        include: ["src/**/*.ts"],
      }),
      "packages/shared/package.json": JSON.stringify({ name: "@scope/shared" }),
      "packages/shared/src/index.ts": "export const shared = true;\n",
    }, { workspaces: ["packages/*"] });

    expect(selectInitialTypeScriptProjectionFiles({
      root,
      seeds: ["packages/app/src/index.ts"],
      depth: 1,
    })?.files).toEqual([
      "packages/app/src/index.ts",
      "packages/app/src/local/value.ts",
      "packages/shared/src/index.ts",
    ]);
  });
});

describe("selectInitialTypeScriptProjectionFiles IPC adjacency", () => {
  it("correlates compatible exact-literal Electron lanes", () => {
    const root = fixture({
      "renderer/send.ts": [
        'import { ipcRenderer as renderer } from "electron";',
        'renderer.send("orders:changed", 1);',
        'renderer.invoke("orders:load");',
      ].join("\n"),
      "main/receive.ts": [
        'const { ipcMain: main } = require("electron");',
        'main.on("orders:changed", () => undefined);',
        'main.handle("orders:load", () => undefined);',
      ].join("\n"),
      "renderer/wrong-lane.ts": [
        'import electron from "electron";',
        'electron.ipcRenderer.on("orders:changed", () => undefined);',
      ].join("\n"),
      "other/event-emitter.ts": 'bus.on("orders:changed", () => undefined);\n',
    });

    expect(selectInitialTypeScriptProjectionFiles({ root, seeds: ["renderer/send.ts"], depth: 1 })).toEqual({
      files: ["main/receive.ts", "renderer/send.ts"],
      seeds: ["renderer/send.ts"],
      frontier: [],
    });
  });

  it("does not let an unresolved invoke lane taint an exact message lane", () => {
    const root = fixture({
      "renderer/send.ts": 'import { ipcRenderer } from "electron"; ipcRenderer.send("orders:load");\n',
      "main/receive.ts": [
        'import { ipcMain } from "electron";',
        'const channels = { load: "orders:load" } as const;',
        "ipcMain.handle(channels.load, () => undefined);",
      ].join("\n"),
    });

    expect(selectInitialTypeScriptProjectionFiles({ root, seeds: ["renderer/send.ts"], depth: 1 })).toEqual({
      files: ["renderer/send.ts"],
      seeds: ["renderer/send.ts"],
      frontier: [],
    });
    expect(selectInitialTypeScriptProjectionFiles({ root, seeds: ["main/receive.ts"], depth: 1 })).toEqual({
      files: ["main/receive.ts"],
      seeds: ["main/receive.ts"],
      frontier: [],
    });
  });

  it.each([
    ["type-only import", 'import type { Rectangle } from "electron";'],
    ["specifier type-only import", 'import { type Rectangle } from "electron";'],
    ["unrelated value import", 'import { Rectangle } from "electron";'],
    ["type-only import-equals", 'import type electron = require("electron");'],
    ["unrelated CommonJS destructuring", 'const { Rectangle } = require("electron");'],
  ])("does not taint an unrelated event emitter from an Electron %s", (_label, electronImport) => {
    const root = fixture({
      "src/events.ts": [
        electronImport,
        'crossWindowEventBus.on("theme", () => undefined);',
      ].join("\n"),
    });

    expect(selectInitialTypeScriptProjectionFiles({ root, seeds: ["src/events.ts"], depth: 1 })).toEqual({
      files: ["src/events.ts"],
      seeds: ["src/events.ts"],
      frontier: [],
    });
  });

  it("conservatively joins compatible invoke and aliased handle participants for readiness", () => {
    const root = fixture({
      "renderer/invoke.ts": 'import { ipcRenderer } from "electron"; ipcRenderer.invoke("orders:load");\n',
      "main/receive.ts": [
        'import { ipcMain } from "electron";',
        "const main = ipcMain;",
        'const channels = { load: "orders:load" } as const;',
        "main.handle(channels.load, () => undefined);",
      ].join("\n"),
    });

    expect(selectInitialTypeScriptProjectionFiles({ root, seeds: ["main/receive.ts"], depth: 1 })).toEqual({
      files: ["main/receive.ts", "renderer/invoke.ts"],
      seeds: ["main/receive.ts"],
      frontier: [],
    });
    expect(selectInitialTypeScriptProjectionFiles({ root, seeds: ["renderer/invoke.ts"], depth: 1 })).toEqual({
      files: ["main/receive.ts", "renderer/invoke.ts"],
      seeds: ["renderer/invoke.ts"],
      frontier: [],
    });
  });

  it("joins compatible aliased endpoints when both channel values require semantic resolution", () => {
    const root = fixture({
      "renderer/invoke.ts": [
        'import { ipcRenderer } from "electron";',
        "const renderer = ipcRenderer;",
        'const channels = { load: "orders:load" } as const;',
        "renderer.invoke(channels.load);",
      ].join("\n"),
      "main/receive.ts": [
        'import { ipcMain } from "electron";',
        "const main = ipcMain;",
        'const channels = { load: "orders:load" } as const;',
        "main.handle(channels.load, () => undefined);",
      ].join("\n"),
    });

    expect(selectInitialTypeScriptProjectionFiles({ root, seeds: ["renderer/invoke.ts"], depth: 1 })).toEqual({
      files: ["main/receive.ts", "renderer/invoke.ts"],
      seeds: ["renderer/invoke.ts"],
      frontier: [],
    });
  });

  it("joins webContents sends to renderer listeners on the reverse message lane", () => {
    const root = fixture({
      "main/window.ts": 'window.webContents.send("theme", "dark");\n',
      "renderer/listener.ts": 'import { ipcRenderer } from "electron"; ipcRenderer.on("theme", () => undefined);\n',
    });

    expect(selectInitialTypeScriptProjectionFiles({ root, seeds: ["main/window.ts"], depth: 1 })?.files).toEqual([
      "main/window.ts",
      "renderer/listener.ts",
    ]);
  });

  it("conservatively joins a dynamic webContents channel to compatible renderer listeners", () => {
    const root = fixture({
      "main/window.ts": [
        'const channels = { theme: "theme" } as const;',
        "window.webContents.send(channels.theme, \"dark\");",
      ].join("\n"),
      "renderer/listener.ts": [
        'import { ipcRenderer } from "electron";',
        'ipcRenderer.on("theme", () => undefined);',
      ].join("\n"),
    });

    expect(selectInitialTypeScriptProjectionFiles({ root, seeds: ["main/window.ts"], depth: 1 })).toEqual({
      files: ["main/window.ts", "renderer/listener.ts"],
      seeds: ["main/window.ts"],
      frontier: [],
    });
  });
});

describe("selectInitialTypeScriptProjectionFiles path and scope guarantees", () => {
  it("uses the shared UTF-16 binary order for mixed-case, BMP, and astral paths", () => {
    const childOrder = [
      "src/Z.ts",
      "src/a.ts",
      "src/é.ts",
      "src/\uE000.ts",
      "src/😀.ts",
    ];
    const canonical = [
      "src/Z.ts",
      "src/a.ts",
      "src/é.ts",
      "src/😀.ts",
      "src/\uE000.ts",
    ];
    const root = fixture(Object.fromEntries(childOrder.map((path) => [path, "export {};\n"])));

    const topology = scanTypeScriptProjectionTopology({ root, seeds: childOrder });

    expect(topology?.seeds).toEqual(canonical);
    expect(topology?.files.map((file) => file.path)).toEqual(canonical);
    expect(selectInitialTypeScriptProjectionFiles({ root, seeds: [...childOrder].reverse(), depth: 0 }))
      .toEqual({ files: canonical, seeds: canonical, frontier: [] });
  });

  it("normalizes seeds, honours manifest source scope, and applies excludes", () => {
    const root = fixture({
      "packages/app/package.json": JSON.stringify({ name: "app" }),
      "packages/app/src/seed.ts": 'import "./kept"; import "./ignored";\n',
      "packages/app/src/kept.ts": "export const kept = true;\n",
      "packages/app/src/ignored.ts": "export const ignored = true;\n",
      "tools/incoming.ts": 'import "../packages/app/src/seed";\n',
    }, { workspaces: ["packages/*"] });

    expect(selectInitialTypeScriptProjectionFiles({
      root,
      seeds: [join(root, "packages/app/src/seed.ts"), ".\\packages\\app\\src\\seed.ts"],
      depth: 1,
      exclude: ["**/ignored.ts"],
    })).toEqual({
      files: ["packages/app/src/kept.ts", "packages/app/src/seed.ts"],
      seeds: ["packages/app/src/seed.ts"],
      frontier: [],
    });
  });

  it("fails closed for invalid depth or missing, excluded, non-source, and escaping seeds", () => {
    const root = fixture({
      "src/seed.ts": "export const seed = true;\n",
      "src/types.d.ts": "declare const value: string;\n",
      "README.md": "hello\n",
    });

    expect(selectInitialTypeScriptProjectionFiles({ root, seeds: ["src/missing.ts"], depth: 1 })).toBeNull();
    expect(selectInitialTypeScriptProjectionFiles({ root, seeds: ["src/types.d.ts"], depth: 1 })).toBeNull();
    expect(selectInitialTypeScriptProjectionFiles({ root, seeds: ["README.md"], depth: 1 })).toBeNull();
    expect(selectInitialTypeScriptProjectionFiles({ root, seeds: ["../outside.ts"], depth: 1 })).toBeNull();
    expect(selectInitialTypeScriptProjectionFiles({
      root,
      seeds: ["src/seed.ts"],
      depth: 1,
      exclude: ["**/seed.ts"],
    })).toBeNull();
    expect(selectInitialTypeScriptProjectionFiles({ root, seeds: ["src/seed.ts"], depth: -1 })).toBeNull();
  });

  it("fails closed while enumerating when the bounded source inventory is exceeded", () => {
    const root = fixture({
      "src/seed.ts": "export const seed = true;\n",
      "src/other.ts": "export const other = true;\n",
    });
    expect(selectInitialTypeScriptProjectionFiles({
      root,
      seeds: ["src/seed.ts"],
      depth: 1,
      maxFiles: 1,
    })).toBeNull();
  });

  it("fails closed before retaining a projection wider than the selected-file bound", () => {
    const root = fixture({
      "src/seed.ts": 'import "./a"; import "./b";\n',
      "src/a.ts": "export const a = true;\n",
      "src/b.ts": "export const b = true;\n",
    });
    expect(selectInitialTypeScriptProjectionFiles({
      root,
      seeds: ["src/seed.ts"],
      depth: 1,
      maxSelectedFiles: 2,
    })).toBeNull();
  });

  it("fails closed while scanning when path or adjacency retention exceeds its bound", () => {
    const root = fixture({
      "src/seed.ts": 'import "./other";\n',
      "src/other.ts": "export const other = true;\n",
    });
    expect(scanTypeScriptProjectionTopology({
      root,
      seeds: ["src/seed.ts"],
      maxPathBytes: 1,
    })).toBeNull();
    expect(scanTypeScriptProjectionTopology({
      root,
      seeds: ["src/seed.ts"],
      maxAdjacencyEntries: 1,
    })).toBeNull();
  });

  it("enforces the adjacency bound while joining unresolved Electron endpoints", () => {
    const root = fixture({
      "renderer/invoke.ts": 'import { ipcRenderer } from "electron"; ipcRenderer.invoke("orders:load");\n',
      "main/receive.ts": [
        'import { ipcMain } from "electron";',
        'const channels = { load: "orders:load" } as const;',
        "ipcMain.handle(channels.load, () => undefined);",
      ].join("\n"),
    });

    expect(scanTypeScriptProjectionTopology({
      root,
      seeds: ["renderer/invoke.ts"],
      maxAdjacencyEntries: 1,
    })).toBeNull();
  });

  it("does not allow test overrides to widen production topology limits", () => {
    const root = fixture({ "src/seed.ts": "export const seed = true;\n" });
    expect(selectInitialTypeScriptProjectionFiles({
      root,
      seeds: ["src/seed.ts"],
      depth: 0,
      maxFiles: 100_001,
    })).toBeNull();
    expect(scanTypeScriptProjectionTopology({
      root,
      seeds: ["src/seed.ts"],
      maxPathBytes: 8 * 1024 * 1024 + 1,
    })).toBeNull();
    expect(scanTypeScriptProjectionTopology({
      root,
      seeds: ["src/seed.ts"],
      maxAdjacencyEntries: 1_000_001,
    })).toBeNull();
  });

  it("accepts an empty seed list without scanning an unsupported projection", () => {
    const root = fixture({ "src/only.ts": "export const only = true;\n" });
    expect(selectInitialTypeScriptProjectionFiles({ root, seeds: [], depth: 1 })).toEqual({
      files: [],
      seeds: [],
      frontier: [],
    });
  });
});
