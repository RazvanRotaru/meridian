export type ResponseLimitErrorFactory = (message: string) => Error;

const defaultError: ResponseLimitErrorFactory = (message) => new Error(message);

/**
 * Read one UTF-8 response without ever buffering more than the advertised byte budget.
 *
 * Counting the raw chunks avoids a second full-payload `TextEncoder` allocation. Streaming the
 * decoder is important: a multi-byte code point may be split across arbitrary network chunks.
 */
export async function readBoundedUtf8Response(
  response: Response,
  maxBytes: number,
  label: string,
  error: ResponseLimitErrorFactory = defaultError,
): Promise<string> {
  requirePositiveByteLimit(maxBytes, error);
  rejectOversizedContentLength(response, maxBytes, label, error);
  if (response.body === null) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const textChunks: string[] = [];
  let receivedBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      receivedBytes += value.byteLength;
      if (receivedBytes > maxBytes) {
        const limitError = error(`${label} response exceeds ${maxBytes} bytes`);
        // Stop the network source immediately. Do not await an arbitrary underlying cancel hook
        // before rejecting the caller; its settlement is deliberately observed and ignored.
        void reader.cancel(limitError).catch(() => undefined);
        throw limitError;
      }
      textChunks.push(decoder.decode(value, { stream: true }));
    }
    textChunks.push(decoder.decode());
    return textChunks.join("");
  } finally {
    reader.releaseLock();
  }
}

export function rejectOversizedContentLength(
  response: Response,
  maxBytes: number,
  label: string,
  error: ResponseLimitErrorFactory = defaultError,
): void {
  const declaredBytes = response.headers.get("content-length");
  if (declaredBytes === null) return;
  const parsed = Number(declaredBytes);
  if (Number.isFinite(parsed) && parsed > maxBytes) {
    // The body has not been read yet, so cancel it as part of the early declared-size rejection.
    const limitError = error(`${label} response exceeds ${maxBytes} bytes`);
    void response.body?.cancel(limitError).catch(() => undefined);
    throw limitError;
  }
}

function requirePositiveByteLimit(value: number, error: ResponseLimitErrorFactory): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw error("maxBytes must be a positive integer");
  }
}
