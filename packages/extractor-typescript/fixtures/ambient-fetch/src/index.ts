export async function callProjectAmbient(): Promise<Response> {
  return fetch("/not-a-platform-fetch");
}
