/** Stable identity for one runtime span card in the request/synthetic flow surface. Static body
 * occurrences append `:exec` and then use the shared Logic-flow address grammar. */
export function requestSpanMomentId(traceId: string, spanId: string): string {
  return `request:${traceId}:span:${spanId}`;
}
