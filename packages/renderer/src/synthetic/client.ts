import { syntheticExecutionSchema } from "@meridian/core";
import type {
  JsonValue,
  SyntheticExecution,
  SyntheticFieldWatcher,
  SyntheticInputOverride,
} from "@meridian/core";

export interface SyntheticExecutionRequest {
  scenarioId: string;
  rootNodeId: string;
  input: JsonValue;
  inputOverrides: SyntheticInputOverride[];
  watchers: SyntheticFieldWatcher[];
}

/** Run one explicitly advertised local scenario. The response crosses the same strict schema
 * boundary as request telemetry; renderer state never trusts arbitrary child-process output. */
export async function requestSyntheticExecution(
  endpoint: string,
  request: SyntheticExecutionRequest,
  options: { sandboxConsent?: boolean } = {},
): Promise<SyntheticExecution> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (options.sandboxConsent === true) headers["x-meridian-sandbox-consent"] = "true";
  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(request),
  });
  const body = await readJson(response);
  if (!response.ok) {
    throw new Error(errorMessage(body, `Synthetic execution failed (${response.status}).`));
  }
  const parsed = syntheticExecutionSchema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.length ? `${issue.path.join(".")}: ` : "";
    throw new Error(`Invalid synthetic execution response (${path}${issue?.message ?? "schema validation failed"}).`);
  }
  return parsed.data;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    if (!response.ok) return null;
    throw new Error("Synthetic execution returned a non-JSON response.");
  }
}

function errorMessage(body: unknown, fallback: string): string {
  if (typeof body !== "object" || body === null) return fallback;
  const error = (body as { error?: unknown }).error;
  return typeof error === "string" && error.trim().length > 0 ? error : fallback;
}
