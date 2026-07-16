export async function loadFromNodeGlobal(): Promise<Response> {
  return fetch("https://api.example.test/jobs?limit=1");
}
