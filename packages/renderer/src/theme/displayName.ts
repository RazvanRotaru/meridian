/**
 * Renderer-side prettifiers. The artifact stores LOCAL source names verbatim
 * (`displayName` is NOT pre-humanized, per ADR 0001) so the renderer owns presentation:
 * a non-technical reader sees "Place Order", not the source token `placeOrder`.
 */

export function titleCase(name: string): string {
  return splitWords(name).map(capitalize).join(" ");
}

function splitWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[\s._-]+/)
    .filter((word) => word.length > 0);
}

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

export function ellipsize(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength - 1).trimEnd()}…`;
}
