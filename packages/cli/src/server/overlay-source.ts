/**
 * What `view` will paint as telemetry: nothing, a synthesized mock, or a single saved file.
 *
 * Resolved once at startup from `--overlay` so the request handlers stay pure switches over
 * this tagged union rather than re-deciding per request.
 */

import type { Overlay } from "@meridian/core";
import { overlaySchema } from "@meridian/core";
import { resolveAgainst } from "../paths";
import { readJsonFile } from "../json-io";
import { CliError, EXIT } from "../errors";

export type OverlaySource =
  | { kind: "none" }
  | { kind: "mock" }
  | { kind: "file"; overlay: Overlay };

export function resolveOverlaySource(option: string | undefined, cwd: string): OverlaySource {
  if (!option) {
    return { kind: "none" };
  }
  if (option === "mock") {
    return { kind: "mock" };
  }
  return { kind: "file", overlay: readOverlayFile(resolveAgainst(cwd, option)) };
}

function readOverlayFile(path: string): Overlay {
  const parsed = overlaySchema.safeParse(readJsonFile(path));
  if (!parsed.success) {
    throw new CliError(EXIT.validation, `overlay ${path} failed validation`, [`  - ${parsed.error.issues[0]?.message ?? "invalid shape"}`]);
  }
  return parsed.data as Overlay;
}

export function hasOverlay(source: OverlaySource): boolean {
  return source.kind !== "none";
}

export function overlayKind(source: OverlaySource): "mock" | "file" | null {
  return source.kind === "none" ? null : source.kind;
}
