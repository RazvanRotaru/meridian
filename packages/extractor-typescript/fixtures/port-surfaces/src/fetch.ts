export async function loadWithDynamicOptions(options: RequestInit): Promise<Response> {
  return fetch("/api/dynamic-options", options);
}

export async function loadWithKnownDefaults(): Promise<Response> {
  return fetch("/api/default", {});
}

const mutableOptions: RequestInit = { method: "POST" };

export async function loadWithMutableAliasedOptions(): Promise<Response> {
  mutableOptions.method = "DELETE";
  return fetch("/api/mutable-options", mutableOptions);
}

export async function loadWithDuplicateMethod(): Promise<Response> {
  // @ts-expect-error Deliberately invalid input: extraction must fail closed rather than invent GET.
  return fetch("/api/duplicate-method", { method: "POST", method: "DELETE" });
}

export async function loadFromFirstOrigin(): Promise<Response> {
  return fetch("https://one.example/api/shared?view=full");
}

export async function loadFromSecondOrigin(): Promise<Response> {
  return fetch("https://two.example/api/shared#summary");
}
