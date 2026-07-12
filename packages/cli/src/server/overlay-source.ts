/**
 * What `view` was configured to paint as telemetry: nothing, a synthesized mock, or one saved
 * file. The in-app selector sees a CATALOG derived from this startup choice: synthetic demo is
 * always available, while a configured file is an additional opaque source. The browser never
 * receives or chooses a server filesystem path.
 *
 * Resolved once at startup from `--overlay` so the request handlers stay pure switches over
 * this tagged union rather than re-deciding per request.
 */

import type { Overlay, TelemetrySourceDescriptor } from "@meridian/core";
import { overlaySchema } from "@meridian/core";
import { resolveAgainst } from "../paths";
import { readJsonFile } from "../json-io";
import { CliError, EXIT } from "../errors";

export type OverlaySource =
  | { kind: "none" }
  | { kind: "mock" }
  | { kind: "file"; overlay: Overlay };

type ActiveOverlaySource = Exclude<OverlaySource, { kind: "none" }>;

export interface TelemetrySourceEntry {
  descriptor: TelemetrySourceDescriptor;
  source: ActiveOverlaySource;
}

export const DEMO_TELEMETRY_SOURCE_ID = "demo";
export const CONFIGURED_TELEMETRY_SOURCE_ID = "configured";

const DEMO_ENVIRONMENTS = ["demo"];
/** Preserve useful startup-mock suggestions; arbitrary explicit environments remain accepted. */
const STARTUP_MOCK_ENVIRONMENTS = ["demo", "dev", "staging", "prod"];

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

/** Public, serializable catalog. `None` is renderer state, not a callable server source. */
export function telemetrySourceDescriptors(
  startup: OverlaySource,
  explicitEnvironment: string | null = null,
): TelemetrySourceDescriptor[] {
  return telemetrySourceCatalog(startup, explicitEnvironment).map((entry) => entry.descriptor);
}

/** A CLI-configured source is prefilled, never loaded; no `--overlay` means the selector starts None. */
export function preselectedTelemetrySourceId(startup: OverlaySource): string | null {
  if (startup.kind === "mock") return DEMO_TELEMETRY_SOURCE_ID;
  if (startup.kind === "file") return CONFIGURED_TELEMETRY_SOURCE_ID;
  return null;
}

/** Resolve an explicit catalog id, or the original startup source for a legacy source-less request. */
export function resolveTelemetrySource(
  startup: OverlaySource,
  sourceId: string | null,
  explicitEnvironment: string | null = null,
): TelemetrySourceEntry | null {
  if (sourceId === null) {
    const legacyId = preselectedTelemetrySourceId(startup);
    return legacyId === null
      ? null
      : telemetrySourceCatalog(startup, explicitEnvironment).find((entry) => entry.descriptor.id === legacyId) ?? null;
  }
  return telemetrySourceCatalog(startup, explicitEnvironment).find((entry) => entry.descriptor.id === sourceId) ?? null;
}

function telemetrySourceCatalog(
  startup: OverlaySource,
  explicitEnvironment: string | null,
): TelemetrySourceEntry[] {
  const startupMock = startup.kind === "mock";
  const demoEnvironments = startupMock
    ? uniqueEnvironments(STARTUP_MOCK_ENVIRONMENTS, explicitEnvironment)
    : DEMO_ENVIRONMENTS;
  const demo: TelemetrySourceEntry = {
    descriptor: {
      id: DEMO_TELEMETRY_SOURCE_ID,
      kind: "mock",
      label: "Synthetic demo",
      provenance: "synthetic",
      environments: [...demoEnvironments],
      environmentMode: startupMock ? "arbitrary" : "enumerated",
      supportsMetrics: true,
      supportsTraces: true,
    },
    source: { kind: "mock" },
  };
  if (startup.kind !== "file") return [demo];
  return [
    demo,
    {
      descriptor: {
        id: CONFIGURED_TELEMETRY_SOURCE_ID,
        kind: "file",
        label: `Configured overlay · ${startup.overlay.env}`,
        provenance: "saved",
        environments: [startup.overlay.env],
        environmentMode: "enumerated",
        supportsMetrics: true,
        supportsTraces: false,
      },
      source: startup,
    },
  ];
}

function uniqueEnvironments(environments: readonly string[], explicitEnvironment: string | null): string[] {
  return [...new Set(explicitEnvironment ? [...environments, explicitEnvironment] : environments)];
}
