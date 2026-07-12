/**
 * Parse a callable's syntactic `signature` string (as produced by the extractor's `signatureOf`:
 * `name(p1: T1, p2?: T2, ...rest: T3[]): Return`) into the typed input/output "pins" the Logic
 * view draws — the Unreal-Blueprints data ports. Pure string work, no type checker: the extractor
 * already resolved the syntax, so a pin only ever shows what the source literally declared (an
 * un-annotated param keeps a null type and reads as `any`; an external/unresolved call has no
 * signature at all, hence no pins — a gap shown honestly, never a guessed port).
 *
 * The one real hazard is commas INSIDE a param's type (`Map<string, number>`, `(a, b) => void`,
 * `{ a, b }`), so every split is bracket-depth aware over `< > ( ) [ ] { }`.
 */

export interface PinSpec {
  name: string;
  /** The declared type, or null when the param carries no annotation. */
  type: string | null;
  optional: boolean;
  rest: boolean;
}

export interface SignatureModel {
  params: PinSpec[];
  /** The declared return type, or null when the signature declares none. */
  returnType: string | null;
}

/** The pin colour family, Blueprints-style: one hue per broad type shape so a flow's data reads at
 * a glance. `array` is the element's shape drawn as a list; `void` is "produces nothing"; `any`
 * covers un-annotated / unknown / `unknown`. */
export type PinCategory = "bool" | "number" | "string" | "object" | "function" | "array" | "void" | "any";

/** A parameter pin plus its resolved colour family — the render-ready input port. */
export type InputPin = PinSpec & { category: PinCategory };

/** The typed I/O a call node draws: input ports (capped for legibility), an optional output port
 * (the return), and the honest count of inputs the cap hid. */
export interface PinModel {
  inputs: InputPin[];
  output: { type: string; category: PinCategory } | null;
  hiddenInputs: number;
}

/** A tall node buries the flow; past this many params the rest collapse into a "+N" row. */
export const MAX_INPUT_PINS = 6;

/** One hue per type family — Blueprints' data-pin colour code, harmonised with the flow palette so a
 * data port never reads as a call/loop accent. void/any are deliberately greyed (a non-colour). */
export const PIN_COLORS: Record<PinCategory, string> = {
  bool: "#E5686A",
  number: "#5FB884",
  string: "#D98AC6",
  object: "#5B9BE8",
  function: "#5FC1CE",
  array: "#E0965A",
  void: "#59616E",
  any: "#8A93A0",
};

/** The fixed height of one pin row, shared by the layout sizing (logicGraph) and the render
 * (logicNodeTypes) so a node's measured box and its drawn ports can never drift apart. */
export const PIN_ROW_H = 20;

/**
 * The render-ready pin model for a callee `signature`, or null when there is nothing to draw — no
 * signature (external/unresolved call), an unparseable one, or a bare `foo()` with no params and no
 * declared return. Inputs past `MAX_INPUT_PINS` are dropped and tallied in `hiddenInputs` so the
 * truncation is stated, never silent.
 */
export function buildPinModel(signature: string | null): PinModel | null {
  const parsed = signature === null ? null : parseSignature(signature);
  if (!parsed) {
    return null;
  }
  const output = parsed.returnType === null ? null : { type: parsed.returnType, category: categorizeType(parsed.returnType) };
  if (parsed.params.length === 0 && output === null) {
    return null;
  }
  const shown = parsed.params.slice(0, MAX_INPUT_PINS);
  return {
    inputs: shown.map((pin) => ({ ...pin, category: categorizeType(pin.type) })),
    output,
    hiddenInputs: parsed.params.length - shown.length,
  };
}

/**
 * Parse `name(params): Return` into its param pins and return type, or null when there is no
 * parameter list to parse (an empty or nameless string). Commas, colons and the `=>` of a function
 * type are all handled at bracket depth so a nested type never splits a param.
 */
export function parseSignature(signature: string): SignatureModel | null {
  const open = signature.indexOf("(");
  if (open === -1) {
    return null;
  }
  const close = matchingParen(signature, open);
  if (close === -1) {
    return null;
  }
  const inside = signature.slice(open + 1, close);
  const after = signature.slice(close + 1).replace(/^\s*:\s*/, "").trim();
  return {
    params: splitTopLevel(inside, ",").map(parseParam).filter((p): p is PinSpec => p !== null),
    returnType: after.length > 0 ? after : null,
  };
}

/** One `name: type` param fragment → a pin, with `?`/`...` lifted into flags. Empty (a trailing
 * comma / no params) yields null so the caller drops it. */
function parseParam(fragment: string): PinSpec | null {
  let text = fragment.trim();
  if (text.length === 0) {
    return null;
  }
  const rest = text.startsWith("...");
  if (rest) {
    text = text.slice(3).trim();
  }
  const colon = indexOfTopLevel(text, ":");
  const rawName = (colon === -1 ? text : text.slice(0, colon)).trim();
  const type = colon === -1 ? null : text.slice(colon + 1).trim() || null;
  const optional = rawName.endsWith("?");
  const name = optional ? rawName.slice(0, -1).trim() : rawName;
  return { name, type, optional, rest };
}

/** Categorise a declared type into its pin colour family. Promise<T> is unwrapped to what it
 * resolves to; arrays win over their element type; a null (un-annotated) type reads as `any`. */
export function categorizeType(type: string | null): PinCategory {
  if (type === null) {
    return "any";
  }
  const t = unwrapPromise(type.trim());
  if (VOID_TYPES.has(t)) return "void";
  if (BOOL_TYPES.has(t)) return "bool";
  if (t === "number" || t === "bigint" || /^-?\d/.test(t)) return "number";
  if (t === "string" || /^["'`]/.test(t)) return "string";
  if (t === "any" || t === "unknown") return "any";
  if (t.endsWith("[]") || /^(Readonly)?Array\s*</.test(t)) return "array";
  if (t.startsWith("(") && t.includes("=>")) return "function";
  if (t === "object" || t.startsWith("{") || /^[A-Z]/.test(t)) return "object";
  return "any";
}

const VOID_TYPES = new Set(["void", "undefined", "null", "never"]);
const BOOL_TYPES = new Set(["boolean", "true", "false"]);

/** Peel one `Promise<...>` layer so an async callee's data pin reads by what it ultimately yields. */
function unwrapPromise(type: string): string {
  const match = type.match(/^Promise\s*<([\s\S]+)>$/);
  return match ? match[1].trim() : type;
}

/** The index of the `)` that closes the `(` at `open`, or -1 if unbalanced. */
function matchingParen(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const char = text[i];
    if (char === "(") depth++;
    else if (char === ")" && --depth === 0) return i;
  }
  return -1;
}

/** Split on `sep` only where bracket depth is zero, so a comma inside a generic/object/function
 * type never breaks a param apart. */
function splitTopLevel(text: string, sep: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    depth += depthDelta(text, i);
    if (depth === 0 && text[i] === sep) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

/** The first index of `char` at bracket depth zero, or -1. */
function indexOfTopLevel(text: string, char: string): number {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    depth += depthDelta(text, i);
    if (depth === 0 && text[i] === char) {
      return i;
    }
  }
  return -1;
}

/** The depth change at position `i`: +1 for an opener, -1 for a closer, 0 otherwise. The `>` of a
 * function type's `=>` is NOT a closer (it has no matching `<`), so it never unbalances the count. */
function depthDelta(text: string, i: number): number {
  const char = text[i];
  if (char === "(" || char === "[" || char === "{" || char === "<") {
    return 1;
  }
  if (char === ")" || char === "]" || char === "}") {
    return -1;
  }
  if (char === ">" && text[i - 1] !== "=") {
    return -1;
  }
  return 0;
}
