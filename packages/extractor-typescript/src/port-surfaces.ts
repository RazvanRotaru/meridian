/**
 * Declarative static models for APIs that cross a process, frame, worker, or network boundary.
 *
 * The analysis engine owns import/type/alias resolution and channel extraction. This file is only
 * the supported-surface catalog: adding a library API should be data, not another branch in the
 * ports pass. The vocabulary intentionally mirrors the useful subset of CodeQL-style library
 * models (origin + member + argument semantics) without coupling Meridian to CodeQL's schema.
 */

import type { PortDirection, PortOperation } from "@meridian/core";

export type PortSurfaceOrigin =
  | {
    kind: "global";
    name: string;
    /**
     * Declaration provenance that proves this is the platform global rather than an application
     * ambient with the same spelling. Paths are normalized before matching and must identify the
     * package-owned declaration, not merely share its basename.
     */
    declarationPathSuffixes: readonly string[];
  }
  | { kind: "import"; module: string; exportName: string }
  | { kind: "factory"; id: string }
  | { kind: "dom"; owners: readonly string[] }
  /**
   * Incomplete projects sometimes erase an external receiver to `any`. A member-name fallback is
   * admitted only when TypeScript cannot resolve that member at all; callers must give it candidate
   * confidence so it can never masquerade as a type-proven API model.
   */
  | { kind: "unresolved-member" }
  /** Compatibility for Electron's `win.webContents.send` when its declarations are unavailable. */
  | { kind: "receiver-suffix"; suffix: string };

/** A call whose returned object acquires a stable modeled API identity. */
export interface PortFactoryDefinition {
  /** Identity referenced by a surface's `{ kind: "factory", id }` origin. */
  resultId: string;
  /** Provenance of the callable or receiver that creates the object. */
  origin: PortSurfaceOrigin;
  /** null models a direct call (`express()`); a string models a member call (`axios.create()`). */
  member: string | null;
  minimumArguments?: number;
  /**
   * Optional identity for the returned transport/client instance. Allocation-site scope is
   * deliberately conservative: two clients created at different sites never become the same
   * endpoint merely because their request paths match. A static config value is display/debug
   * evidence inside that identity, not a substitute for allocation identity.
   */
  scope?: {
    kind: "allocation-site";
    staticConfig?: { argument: number; property: string };
  };
}

export type PortChannelRule =
  | { kind: "literal-argument"; index: number }
  | { kind: "http-fetch"; urlArgument: number; optionsArgument: number }
  | { kind: "http-member"; urlArgument: number }
  | { kind: "web-message-send"; payloadArgument: number }
  | { kind: "web-message-listener"; handlerArgument: number };

export interface PortSurfaceDefinition {
  id: string;
  origin: PortSurfaceOrigin;
  /** null identifies a direct call such as global `fetch(...)`. */
  member: string | null;
  protocol: string;
  direction: PortDirection;
  operation: PortOperation;
  channel: PortChannelRule;
  /** Transport route used to prevent same-name channels on incompatible API lanes from joining. */
  lane?: string;
  /** Static correlation strength. Omitted means exact; selectors such as postMessage `type` are candidates. */
  confidence?: number;
  /** Generic call-shape constraint (for example Express routes require a handler argument). */
  minimumArguments?: number;
  /** Callback argument to continue causal traversal into; negative indexes count from the end. */
  handlerArgument?: number;
  /** Literal call-site filter, e.g. addEventListener("message", ...). */
  requiresLiteralArgument?: { index: number; value: string };
}

/** The complete declarative input to the reusable ports interpreter. */
export interface PortModelCatalog {
  surfaces: readonly PortSurfaceDefinition[];
  factories: readonly PortFactoryDefinition[];
}

const ELECTRON_RENDERER_OUT = [
  ["send", "notify", "renderer-main-message"],
  ["sendSync", "request", "renderer-main-message"],
  ["invoke", "request", "renderer-main-invoke"],
  ["postMessage", "notify", "renderer-main-message"],
  ["sendToHost", "notify", "renderer-host-message"],
] as const;

const ELECTRON_RENDERER_IN = ["on", "once", "addListener"] as const;
const ELECTRON_MAIN_IN = [
  ["on", "subscribe", "renderer-main-message"],
  ["once", "subscribe", "renderer-main-message"],
  ["addListener", "subscribe", "renderer-main-message"],
  ["handle", "handle", "renderer-main-invoke"],
  ["handleOnce", "handle", "renderer-main-invoke"],
] as const;

const HTTP_VERBS = ["get", "post", "put", "patch", "delete", "head", "options"] as const;
const EXPRESS_VERBS = ["get", "post", "put", "patch", "delete", "all"] as const;

const FETCH_GLOBAL: PortSurfaceOrigin = {
  kind: "global",
  name: "fetch",
  declarationPathSuffixes: [
    "/typescript/lib/lib.dom.d.ts",
    "/typescript/lib/lib.webworker.d.ts",
    "/@types/node/web-globals/fetch.d.ts",
  ],
};

const AXIOS_INSTANCE_ID = "axios.instance";
const EXPRESS_APPLICATION_ID = "express.application";

const importedMember = (
  id: string,
  module: string,
  exportName: string,
  member: string,
  protocol: string,
  direction: PortDirection,
  operation: PortOperation,
  channel: PortChannelRule,
  extra: Partial<Pick<PortSurfaceDefinition, "lane" | "confidence" | "minimumArguments" | "handlerArgument">> = {},
): PortSurfaceDefinition => ({
  id,
  origin: { kind: "import", module, exportName },
  member,
  protocol,
  direction,
  operation,
  channel,
  ...extra,
});

export const BUILTIN_PORT_SURFACES: readonly PortSurfaceDefinition[] = [
  {
    id: "web.fetch",
    origin: FETCH_GLOBAL,
    member: null,
    protocol: "http",
    direction: "out",
    operation: "request",
    channel: { kind: "http-fetch", urlArgument: 0, optionsArgument: 1 },
    minimumArguments: 1,
  },
  ...HTTP_VERBS.map((member) => importedMember(
    `axios.${member}`,
    "axios",
    "default",
    member,
    "http",
    "out",
    "request",
    { kind: "http-member", urlArgument: 0 },
    { minimumArguments: 1 },
  )),
  ...HTTP_VERBS.map((member): PortSurfaceDefinition => ({
    id: `axios.instance.${member}`,
    origin: { kind: "factory", id: AXIOS_INSTANCE_ID },
    member,
    protocol: "http",
    direction: "out",
    operation: "request",
    channel: { kind: "http-member", urlArgument: 0 },
    minimumArguments: 1,
  })),
  ...EXPRESS_VERBS.map((member): PortSurfaceDefinition => ({
    id: `express.${member}`,
    origin: { kind: "factory", id: EXPRESS_APPLICATION_ID },
    member,
    protocol: "http",
    direction: "in",
    operation: "handle",
    channel: { kind: "http-member", urlArgument: 0 },
    minimumArguments: 2,
    handlerArgument: -1,
  })),
  ...ELECTRON_RENDERER_OUT.map(([member, operation, lane]) => importedMember(
    `electron.ipcRenderer.${member}`,
    "electron",
    "ipcRenderer",
    member,
    "electron",
    "out",
    operation,
    { kind: "literal-argument", index: 0 },
    { lane, minimumArguments: 1 },
  )),
  ...ELECTRON_RENDERER_IN.map((member) => importedMember(
    `electron.ipcRenderer.${member}`,
    "electron",
    "ipcRenderer",
    member,
    "electron",
    "in",
    "subscribe",
    { kind: "literal-argument", index: 0 },
    { lane: "main-renderer-message", minimumArguments: 2, handlerArgument: 1 },
  )),
  ...ELECTRON_MAIN_IN.map(([member, operation, lane]) => importedMember(
    `electron.ipcMain.${member}`,
    "electron",
    "ipcMain",
    member,
    "electron",
    "in",
    operation,
    { kind: "literal-argument", index: 0 },
    { lane, minimumArguments: 2, handlerArgument: 1 },
  )),
  {
    id: "electron.webContents.send",
    origin: { kind: "receiver-suffix", suffix: ".webContents" },
    member: "send",
    protocol: "electron",
    direction: "out",
    operation: "notify",
    channel: { kind: "literal-argument", index: 0 },
    lane: "main-renderer-message",
    confidence: 0.6,
    minimumArguments: 1,
  },
  {
    id: "electron.webContents.postMessage",
    origin: { kind: "receiver-suffix", suffix: ".webContents" },
    member: "postMessage",
    protocol: "electron",
    direction: "out",
    operation: "notify",
    channel: { kind: "literal-argument", index: 0 },
    lane: "main-renderer-message",
    confidence: 0.6,
    minimumArguments: 1,
  },
  {
    id: "web.window.postMessage",
    origin: { kind: "dom", owners: ["Window", "WindowProxy"] },
    member: "postMessage",
    protocol: "postmessage",
    direction: "out",
    operation: "notify",
    channel: { kind: "web-message-send", payloadArgument: 0 },
    lane: "window-message",
    confidence: 0.65,
    minimumArguments: 1,
  },
  {
    id: "web.window.postMessage.unresolved",
    origin: { kind: "unresolved-member" },
    member: "postMessage",
    protocol: "postmessage",
    direction: "out",
    operation: "notify",
    channel: { kind: "web-message-send", payloadArgument: 0 },
    lane: "window-message",
    confidence: 0.35,
    // The unresolved fallback keeps the Window-like payload + target-origin shape. Typed one-arg
    // MessagePort/WebView APIs should get their own registry model instead of joining this lane.
    minimumArguments: 2,
  },
  {
    id: "web.window.addEventListener.message",
    origin: { kind: "dom", owners: ["Window", "WindowProxy"] },
    member: "addEventListener",
    protocol: "postmessage",
    direction: "in",
    operation: "subscribe",
    channel: { kind: "web-message-listener", handlerArgument: 1 },
    lane: "window-message",
    confidence: 0.65,
    minimumArguments: 2,
    handlerArgument: 1,
    requiresLiteralArgument: { index: 0, value: "message" },
  },
];

/**
 * Factory recognition is catalog data too: adding another client/bus/router no longer requires a
 * branch in the analysis engine. Multiple creators may intentionally produce the same result id.
 */
export const BUILTIN_PORT_FACTORIES: readonly PortFactoryDefinition[] = [
  {
    resultId: EXPRESS_APPLICATION_ID,
    origin: { kind: "import", module: "express", exportName: "default" },
    member: null,
  },
  {
    resultId: EXPRESS_APPLICATION_ID,
    origin: { kind: "import", module: "express", exportName: "default" },
    member: "Router",
  },
  {
    resultId: AXIOS_INSTANCE_ID,
    origin: { kind: "import", module: "axios", exportName: "default" },
    member: "create",
    scope: {
      kind: "allocation-site",
      staticConfig: { argument: 0, property: "baseURL" },
    },
  },
];

export const BUILTIN_PORT_MODELS: PortModelCatalog = {
  surfaces: BUILTIN_PORT_SURFACES,
  factories: BUILTIN_PORT_FACTORIES,
};
