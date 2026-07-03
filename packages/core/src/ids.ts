/**
 * The node-id grammar: `<lang>:<modulePath>[#<qualname>][~<n>]`.
 *
 * This is the generalized, cross-language `__qualname__` and the telemetry join key. The
 * helpers here are the only place that knows the grammar; producers build ids through
 * `buildNodeId`, consumers read them through `parseNodeId`.
 */

import type { NodeId } from "./types";

const LANG_DELIMITER = ":";
const QUALNAME_DELIMITER = "#";
const ORDINAL_DELIMITER = "~";
const SCOPE_SEPARATOR = ".";

export interface NodeIdParts {
  lang: string;
  modulePath: string;
  qualname?: string;
  ordinal?: number;
}

export function buildNodeId(parts: NodeIdParts): NodeId {
  let id = `${parts.lang}${LANG_DELIMITER}${parts.modulePath}`;
  if (parts.qualname) {
    id += `${QUALNAME_DELIMITER}${parts.qualname}`;
  }
  if (parts.ordinal && parts.ordinal > 0) {
    id += `${ORDINAL_DELIMITER}${parts.ordinal}`;
  }
  return id;
}

export function parseNodeId(id: NodeId): NodeIdParts {
  const langDelimiter = id.indexOf(LANG_DELIMITER);
  const lang = id.slice(0, langDelimiter);
  const remainder = stripOrdinal(id.slice(langDelimiter + 1));
  return { lang, ...splitModuleAndQualname(remainder.body), ordinal: remainder.ordinal };
}

function stripOrdinal(rest: string): { body: string; ordinal?: number } {
  const ordinalDelimiter = rest.lastIndexOf(ORDINAL_DELIMITER);
  if (ordinalDelimiter === -1 || !/^\d+$/.test(rest.slice(ordinalDelimiter + 1))) {
    return { body: rest };
  }
  return { body: rest.slice(0, ordinalDelimiter), ordinal: Number(rest.slice(ordinalDelimiter + 1)) };
}

function splitModuleAndQualname(body: string): { modulePath: string; qualname?: string } {
  const qualnameDelimiter = body.indexOf(QUALNAME_DELIMITER);
  if (qualnameDelimiter === -1) {
    return { modulePath: body };
  }
  return { modulePath: body.slice(0, qualnameDelimiter), qualname: body.slice(qualnameDelimiter + 1) };
}

/** Normalize native scope separators (`::`, `#`, `$`) to the canonical `.`. */
export function normalizeScopeSeparators(qualname: string): string {
  return qualname.replace(/::|#|\$/g, SCOPE_SEPARATOR);
}

/** Collapse Python `<locals>` segments so closures match the TS shape. */
export function collapseLocals(qualname: string): string {
  return qualname.replace(/\.<locals>/g, "");
}
