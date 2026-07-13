import type { ReactNode } from "react";

/** Small safe renderer for the Markdown GitHub puts in review comments. React owns all emitted
 * markup; unsupported HTML is stripped to text, so a comment can never inject page content. */
export function GitHubMarkdown({ source }: { source: string }) {
  const normalized = source
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?(?:sub|sup|details|summary)>/gi, "")
    .replace(/<[^>]*>/g, "");
  return <>{renderInline(normalized, "comment")}</>;
}

interface InlineMatch {
  index: number;
  length: number;
  node: (key: string) => ReactNode;
}

function renderInline(source: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let rest = source;
  let part = 0;
  while (rest.length > 0) {
    const match = firstInlineMatch(rest);
    if (match === null) {
      nodes.push(rest);
      break;
    }
    if (match.index > 0) {
      nodes.push(rest.slice(0, match.index));
    }
    nodes.push(match.node(`${keyPrefix}-${part++}`));
    rest = rest.slice(match.index + match.length);
  }
  return nodes;
}

function firstInlineMatch(source: string): InlineMatch | null {
  const matches = [imageMatch(source), linkMatch(source), codeMatch(source), strongMatch(source)]
    .filter((match): match is InlineMatch => match !== null)
    .sort((left, right) => left.index - right.index);
  return matches[0] ?? null;
}

function imageMatch(source: string): InlineMatch | null {
  const match = /!\[([^\]]*)\]\((https?:\/\/[^\s)]+)(?:\s+"[^"]*")?\)/i.exec(source);
  if (!match) return null;
  return {
    index: match.index,
    length: match[0].length,
    node: (key) => <img key={key} src={match[2]} alt={match[1]} style={IMAGE_STYLE} loading="lazy" />,
  };
}

function linkMatch(source: string): InlineMatch | null {
  const match = /(?<!!)\[([^\]]+)\]\((https?:\/\/[^\s)]+)(?:\s+"[^"]*")?\)/i.exec(source);
  if (!match) return null;
  return {
    index: match.index,
    length: match[0].length,
    node: (key) => <a key={key} href={match[2]} target="_blank" rel="noreferrer" style={LINK_STYLE}>{match[1]}</a>,
  };
}

function codeMatch(source: string): InlineMatch | null {
  const match = /`([^`\n]+)`/.exec(source);
  if (!match) return null;
  return {
    index: match.index,
    length: match[0].length,
    node: (key) => <code key={key} style={CODE_STYLE}>{match[1]}</code>,
  };
}

function strongMatch(source: string): InlineMatch | null {
  const match = /\*\*([\s\S]+?)\*\*/.exec(source);
  if (!match) return null;
  return {
    index: match.index,
    length: match[0].length,
    node: (key) => <strong key={key}>{renderInline(match[1], `${key}-strong`)}</strong>,
  };
}

const IMAGE_STYLE: React.CSSProperties = { display: "inline-block", maxWidth: 180, maxHeight: 20, verticalAlign: "text-bottom" };
const LINK_STYLE: React.CSSProperties = { color: "#7DD3FC", textDecoration: "underline" };
const CODE_STYLE: React.CSSProperties = { padding: "1px 4px", borderRadius: 4, background: "#20262F", color: "#E6EDF3", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: "0.92em" };
