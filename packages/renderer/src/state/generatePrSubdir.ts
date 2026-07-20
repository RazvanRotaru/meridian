import type { PrSessionSource } from "./prTypes";

/** Re-run the existing web generate route against this session's repository and a broader root. */
export async function generatePrSubdir(source: PrSessionSource, subdir: string, signal: AbortSignal): Promise<string> {
  const response = await fetch("/api/generate", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "github", value: source.repository, subdir }),
    signal,
  });
  const data = (await response.json()) as { id?: unknown; error?: unknown };
  if (!response.ok || typeof data.id !== "string") {
    throw new Error(typeof data.error === "string" ? data.error : "Re-extraction failed.");
  }
  return data.id;
}
