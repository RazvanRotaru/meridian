/**
 * Best-effort fetch of the selectable environments from the CLI's meta endpoint.
 *
 * The list only POPULATES the selector's options; it never pre-selects one. If meta is
 * unreachable (e.g. plain `vite dev`) we fall back to a neutral dev list so the mandatory
 * selector still renders with a real choice to make — prod included but never first.
 */

const DEV_ENVIRONMENTS = ["staging", "prod"];

interface MetaResponse {
  environments?: string[];
}

export async function loadEnvironments(metaUrl: string): Promise<string[]> {
  try {
    return await fetchEnvironments(metaUrl);
  } catch {
    return DEV_ENVIRONMENTS;
  }
}

async function fetchEnvironments(metaUrl: string): Promise<string[]> {
  const response = await fetch(metaUrl);
  if (!response.ok) {
    return DEV_ENVIRONMENTS;
  }
  const meta = (await response.json()) as MetaResponse;
  return meta.environments && meta.environments.length > 0 ? meta.environments : DEV_ENVIRONMENTS;
}
