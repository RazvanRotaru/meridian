/**
 * Ports pass: detect the statically recognizable IPC surfaces — the points where this code talks
 * across a process boundary — and emit them as typed `Port`s (direction + protocol + channel key).
 *
 * v1 matchers, chosen for unambiguous surfaces and literal channels:
 *   electron  — ipcRenderer.send/invoke (out) · ipcRenderer.on, ipcMain.on/handle/handleOnce/once
 *               (in) · *.webContents.send (out), matched by the `electron` import's local names.
 *   http out  — global fetch(url[, {method}]) · axios.<verb>(url), matched by the `axios` import.
 *   http in   — <app>.<verb>("/path", handler) where <app> came from express() / express.Router().
 *
 * HONESTY RULE: the channel is read ONLY from a string literal (or expression-free template).
 * Anything dynamic yields `channel: null` — the port is still reported (the boundary exists!),
 * it just joins nothing. Matching is textual against import names, not the type checker, so
 * fixtures and cloned repos work without their dependencies installed.
 */

import { Node, SyntaxKind, type CallExpression, type SourceFile } from "ts-morph";
import type { Port } from "@meridian/core";
import { callSiteOf, nodeKey, type NodeDescriptor } from "./model";
import type { LoadedProject } from "./project-loader";
import type { ResolutionIndex } from "./resolution-index";

const ELECTRON_OUT = new Set(["send", "invoke"]);
const ELECTRON_IN = new Set(["on", "once", "handle", "handleOnce"]);
const AXIOS_VERBS = new Set(["get", "post", "put", "patch", "delete", "head", "options"]);
const EXPRESS_VERBS = new Set(["get", "post", "put", "patch", "delete", "all"]);
const LABEL_CAP = 80;

export function collectPorts(
  loaded: LoadedProject,
  index: ResolutionIndex,
  moduleByFilePath: Map<string, NodeDescriptor>,
): Port[] {
  const ports: Port[] = [];
  for (const sourceFile of loaded.sourceFiles) {
    const relPath = loaded.relativePathOf(sourceFile);
    const names = importNames(sourceFile);
    const apps = expressAppNames(sourceFile, names.express);
    for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const port = matchCall(call, names, apps, relPath, index, moduleByFilePath);
      if (port) {
        ports.push(port);
      }
    }
  }
  return ports;
}

/** The local names each matched library was imported under (aliases included). */
interface ImportNames {
  ipcRenderer: Set<string>;
  ipcMain: Set<string>;
  axios: Set<string>;
  express: Set<string>;
}

function importNames(sourceFile: SourceFile): ImportNames {
  const names: ImportNames = { ipcRenderer: new Set(), ipcMain: new Set(), axios: new Set(), express: new Set() };
  for (const declaration of sourceFile.getImportDeclarations()) {
    const specifier = declaration.getModuleSpecifierValue();
    if (specifier === "electron") {
      for (const named of declaration.getNamedImports()) {
        const local = (named.getAliasNode() ?? named.getNameNode()).getText();
        if (named.getName() === "ipcRenderer") names.ipcRenderer.add(local);
        if (named.getName() === "ipcMain") names.ipcMain.add(local);
      }
    }
    if (specifier === "axios") {
      const def = declaration.getDefaultImport();
      if (def) names.axios.add(def.getText());
    }
    if (specifier === "express") {
      const def = declaration.getDefaultImport();
      if (def) names.express.add(def.getText());
    }
  }
  return names;
}

/** Variables assigned from `express()` or `<express>.Router()` — the receivers of route methods. */
function expressAppNames(sourceFile: SourceFile, expressNames: ReadonlySet<string>): Set<string> {
  const apps = new Set<string>();
  if (expressNames.size === 0) {
    return apps;
  }
  for (const declaration of sourceFile.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
    const initializer = declaration.getInitializer();
    if (!initializer || !Node.isCallExpression(initializer)) {
      continue;
    }
    const callee = initializer.getExpression().getText();
    const isApp = expressNames.has(callee);
    const isRouter = [...expressNames].some((name) => callee === `${name}.Router`);
    if (isApp || isRouter) {
      apps.add(declaration.getName());
    }
  }
  return apps;
}

function matchCall(
  call: CallExpression,
  names: ImportNames,
  apps: ReadonlySet<string>,
  relPath: string,
  index: ResolutionIndex,
  moduleByFilePath: Map<string, NodeDescriptor>,
): Port | null {
  const callee = call.getExpression();
  const emit = (direction: "in" | "out", protocol: string, channel: string | null, label: string): Port => ({
    nodeId: owningNodeId(call, index, moduleByFilePath),
    direction,
    protocol,
    channel,
    label: label.slice(0, LABEL_CAP),
    callSite: callSiteOf(call, relPath),
  });

  // fetch("/api/x", { method: "POST" }) — the global, no import to anchor on.
  if (Node.isIdentifier(callee) && callee.getText() === "fetch" && call.getArguments().length > 0) {
    const url = literalText(call.getArguments()[0]);
    const method = fetchMethod(call);
    return emit("out", "http", url === null ? null : `${method} ${pathOf(url)}`, argLabel(call));
  }

  if (!Node.isPropertyAccessExpression(callee)) {
    return null;
  }
  const receiver = callee.getExpression().getText();
  const method = callee.getName();

  if (names.ipcRenderer.has(receiver) && ELECTRON_OUT.has(method)) {
    return emit("out", "electron", literalText(call.getArguments()[0]), argLabel(call));
  }
  if ((names.ipcRenderer.has(receiver) && method === "on") || (names.ipcMain.has(receiver) && ELECTRON_IN.has(method))) {
    return emit("in", "electron", literalText(call.getArguments()[0]), argLabel(call));
  }
  // win.webContents.send("chan") — main-process push to a renderer, matched by the chain's tail.
  if (method === "send" && receiver.endsWith(".webContents")) {
    return emit("out", "electron", literalText(call.getArguments()[0]), argLabel(call));
  }
  if (names.axios.has(receiver) && AXIOS_VERBS.has(method)) {
    const url = literalText(call.getArguments()[0]);
    return emit("out", "http", url === null ? null : `${method.toUpperCase()} ${pathOf(url)}`, argLabel(call));
  }
  // app.get("/path", handler) — require the handler arg so express's config getter app.get("x") never matches.
  if (apps.has(receiver) && EXPRESS_VERBS.has(method) && call.getArguments().length >= 2) {
    const path = literalText(call.getArguments()[0]);
    return emit("in", "http", path === null ? null : `${method.toUpperCase()} ${pathOf(path)}`, argLabel(call));
  }
  return null;
}

/** The channel string, ONLY when statically knowable; a template with expressions is dynamic. */
function literalText(argument: Node | undefined): string | null {
  if (!argument) {
    return null;
  }
  if (Node.isStringLiteral(argument) || Node.isNoSubstitutionTemplateLiteral(argument)) {
    return argument.getLiteralText();
  }
  return null;
}

/** `fetch`'s method from an inline `{ method: "POST" }` options literal; GET otherwise. */
function fetchMethod(call: CallExpression): string {
  const options = call.getArguments()[1];
  if (!options || !Node.isObjectLiteralExpression(options)) {
    return "GET";
  }
  const property = options.getProperty("method");
  if (property && Node.isPropertyAssignment(property)) {
    const value = literalText(property.getInitializer());
    if (value) {
      return value.toUpperCase();
    }
  }
  return "GET";
}

/** URL → route path: strip an absolute origin, the query, and the hash; guarantee a leading `/`. */
function pathOf(url: string): string {
  let path = url.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]+/i, "");
  path = path.split("?")[0].split("#")[0];
  return path.startsWith("/") ? path : `/${path}`;
}

function argLabel(call: CallExpression): string {
  return call.getArguments()[0]?.getText() ?? call.getText();
}

/** The enclosing emitted callable, else the file's module node — same attribution as the edge pass. */
function owningNodeId(
  site: Node,
  index: ResolutionIndex,
  moduleByFilePath: Map<string, NodeDescriptor>,
): string {
  let current = site.getParent();
  while (current) {
    const enclosing = index.sourceByCallableKey.get(nodeKey(current));
    if (enclosing) {
      return enclosing;
    }
    current = current.getParent();
  }
  return moduleByFilePath.get(site.getSourceFile().getFilePath())?.finalId ?? "";
}
