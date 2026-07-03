/** A minimal HTTP-style response shared by every route handler. */
export interface ApiResponse {
  status: number;
  body: unknown;
}

/** Shape a 200 OK response. */
export function ok(body: unknown): ApiResponse {
  return { status: 200, body };
}

/** Shape a 201 Created response. */
export function created(body: unknown): ApiResponse {
  return { status: 201, body };
}

/** Shape a 4xx/5xx error response. */
export function fail(status: number, message: string): ApiResponse {
  return { status, body: { error: message } };
}
