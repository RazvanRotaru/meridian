function fetch(path: string): string {
  return `local:${path}`;
}

export function callLocalFetch(): string {
  return fetch("/not-an-http-boundary");
}
