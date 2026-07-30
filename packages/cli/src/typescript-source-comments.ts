import type { SourceLineCommentProjection } from "@meridian/core";
import { ts } from "ts-morph";

/**
 * Project JavaScript-family source with the TypeScript parser's own lexical decisions. Traversing
 * token trivia prevents URL-like JSX text, regex literals, and template contents from being
 * mistaken for comments.
 */
export function typescriptLineCommentProjections(
  file: string,
  code: string,
  startLine: number,
): readonly SourceLineCommentProjection[] {
  const sourceFile = ts.createSourceFile(
    file,
    code,
    ts.ScriptTarget.Latest,
    true,
    scriptKind(file),
  );
  const ranges = commentRanges(sourceFile, code);
  const lines = code.length === 0 ? [] : code.split("\n");
  const projected = lines.map((): {
    code: string;
    comment: boolean;
    semanticDirective?: true;
  } => ({ code: "", comment: false }));
  let line = 0;
  let rangeIndex = 0;

  for (let index = 0; index < code.length; index += 1) {
    while (ranges[rangeIndex] && index >= ranges[rangeIndex].end) rangeIndex += 1;
    const range = ranges[rangeIndex];
    if (code[index] === "\n") {
      // A physically empty row inside a block comment has no comment characters of its own, but
      // it is still comment-owned source and must remain classifiable.
      if (range && index >= range.pos && index < range.end) {
        projected[line].comment = true;
        if (range.semanticDirective) projected[line].semanticDirective = true;
      }
      line += 1;
      continue;
    }
    if (range && index >= range.pos && index < range.end) {
      projected[line].comment = true;
      if (range.semanticDirective) projected[line].semanticDirective = true;
      if (code[index] === "\r" || code[index] === "\u2028" || code[index] === "\u2029") {
        // These remain ECMAScript line terminators even inside a block comment and can trigger ASI
        // (notably after `return`). Preserve them in the executable signature.
        projected[line].code += code[index];
      }
      // JavaScript comments are lexical whitespace only when they separate source on both sides.
      // A prefix/trailing comment contributes no token boundary; an interior comment contributes
      // one stable separator so `typeof/* old */foo` cannot collapse to `typeoffoo/* new */`.
      if (
        index === range.pos
        && /\S/.test(projected[line].code)
        && hasNonWhitespaceBeforeLineEnd(code, range.end)
      ) {
        projected[line].code += " ";
      }
    } else {
      projected[line].code += code[index];
    }
  }

  return projected.map((projection, index) => ({
    line: startLine + index,
    code: projection.code,
    comment: projection.comment,
    ...(projection.semanticDirective ? { semanticDirective: true as const } : {}),
  }));
}

interface CommentRange {
  pos: number;
  end: number;
  semanticDirective?: true;
}

function commentRanges(sourceFile: ts.SourceFile, code: string): CommentRange[] {
  const ranges = new Map<string, CommentRange>();
  const jsxTextRanges: CommentRange[] = [];
  const append = (values: readonly ts.CommentRange[] | undefined): void => {
    for (const value of values ?? []) {
      ranges.set(`${value.pos}:${value.end}`, { pos: value.pos, end: value.end });
    }
  };
  const pending: ts.Node[] = [sourceFile];
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (node.kind === ts.SyntaxKind.JsxText) {
      jsxTextRanges.push({ pos: node.pos, end: node.end });
    }
    append(ts.getLeadingCommentRanges(code, node.getFullStart()));
    append(ts.getTrailingCommentRanges(code, node.getEnd()));
    pending.push(...node.getChildren(sourceFile));
  }
  const comments = [...ranges.values()]
    .sort((left, right) => left.pos - right.pos || left.end - right.end);
  const jsx = jsxTextRanges.sort((left, right) => left.pos - right.pos || left.end - right.end);
  let jsxIndex = 0;
  return comments.filter((range) => {
    while (jsx[jsxIndex] && jsx[jsxIndex].end <= range.pos) jsxIndex += 1;
    const text = jsx[jsxIndex];
    return !(text && range.pos >= text.pos && range.end <= text.end);
  }).map((range) => {
    const expanded = expandHorizontalTrivia(code, range);
    return semanticTypeScriptDirective(code.slice(range.pos, range.end))
      ? { ...expanded, semanticDirective: true as const }
      : expanded;
  });
}

function expandHorizontalTrivia(code: string, range: CommentRange): CommentRange {
  let pos = range.pos;
  let end = range.end;
  while (pos > 0 && (code[pos - 1] === " " || code[pos - 1] === "\t")) pos -= 1;
  while (end < code.length && (code[end] === " " || code[end] === "\t")) end += 1;
  return { pos, end };
}

function hasNonWhitespaceBeforeLineEnd(code: string, start: number): boolean {
  for (let index = start; index < code.length; index += 1) {
    const value = code[index];
    if (value === "\n" || value === "\r" || value === "\u2028" || value === "\u2029") break;
    if (value !== " " && value !== "\t") return true;
  }
  return false;
}

function semanticTypeScriptDirective(text: string): boolean {
  return /^\s*\/\/\/\s*<(?:reference|amd-module|amd-dependency)\b/im.test(text)
    || /^\s*\/\*---(?:\s|$)/m.test(text)
    || /(?:\/\/|\/\*+|\*)\s*@[A-Za-z_$][\w$-]*\b/.test(text)
    || /(?:\/\/|\/\*+|\*)\s*(?:@(?:ts-(?:check|nocheck|ignore|expect-error|types|self-types)|deno-types)\b|[#@]__(?:PURE|NO_SIDE_EFFECTS|INLINE|NOINLINE|MANGLE_PROP|KEY)__\b)/i.test(text)
    || /(?:\/\/|\/\*+|\*)\s*(?:[#@]\s*)?(?:sourceMappingURL|sourceURL)\s*=/i.test(text)
    || /(?:\/\/|\/\*+|\*)\s*META\s*:/.test(text)
    || /(?:\/\/|\/\*+|\*)\s*@?(?:eslint|tslint|stylelint|prettier|biome|oxlint|deno-(?:lint|fmt|coverage)|istanbul|c8|v8|nyc|webpack|vite|rollup|babel|swc|jest)(?:[-A-Z_a-z\s:]|$)/i.test(text)
    || /(?:\/\/|\/\*+|\*)\s*(?:node:coverage\b|nosemgrep\b|NOSONAR\b)/i.test(text)
    || /(?:\/\/|\/\*+|\*)\s*@(?:jsx|jsxFrag|jsxImportSource|jsxRuntime|flow|noflow|format|ngInject|ngNoInject|internal|public|private|protected|readonly|override|deprecated|alpha|beta|define|nocollapse|export|const|packageDocumentation|typedef|type|satisfies|template|this|enum|implements|extends|augments|constructor|class|interface|overload|param|arg|argument|returns?|property|prop|callback|import)\b/i.test(text)
    || /(?:\/\/|\/\*+|\*)\s*@(?:license|preserve)\b/i.test(text)
    || /^\s*(?:\/\*!|\/\/!)/m.test(text)
    || /\/\*+\s*:{1,2}(?:\s|[A-Za-z_$<{[(])/i.test(text)
    || /\/\*+\s*(?:global|exported)\b/i.test(text);
}

function scriptKind(file: string): ts.ScriptKind {
  const path = file.toLowerCase();
  if (path.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (path.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (path.endsWith(".js") || path.endsWith(".mjs") || path.endsWith(".cjs")) {
    return ts.ScriptKind.JS;
  }
  return ts.ScriptKind.TS;
}
