/**
 * The PR list's client-side filter row: a substring search (PR number or title) and an author
 * <select>. Both are ephemeral view state owned by PrsView — this component is presentational.
 * Rendered only when the loaded list has at least one PR to filter.
 */

export function PrsFilterBar(props: {
  query: string;
  onQueryChange: (value: string) => void;
  author: string;
  onAuthorChange: (value: string) => void;
  authors: readonly string[];
}) {
  return (
    <div style={BAR_STYLE}>
      <input
        style={SEARCH_INPUT_STYLE}
        placeholder="Search by number or title…"
        value={props.query}
        onChange={(event) => props.onQueryChange(event.target.value)}
        aria-label="Search pull requests"
      />
      <select
        style={SELECT_STYLE}
        value={props.author}
        onChange={(event) => props.onAuthorChange(event.target.value)}
        aria-label="Filter by author"
      >
        <option value="">All authors</option>
        {props.authors.map((author) => (
          <option key={author} value={author}>
            {author}
          </option>
        ))}
      </select>
    </div>
  );
}

const BAR_STYLE: React.CSSProperties = { display: "flex", gap: 8, marginBottom: 12 };
const SEARCH_INPUT_STYLE: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  boxSizing: "border-box",
  fontSize: 13,
  padding: "8px 10px",
  background: "#10151C",
  border: "1px solid #2A2F37",
  borderRadius: 8,
  color: "#E6EDF3",
  outline: "none",
};
const SELECT_STYLE: React.CSSProperties = {
  flex: "0 0 auto",
  // Long GitHub logins (up to 39 chars) truncate instead of squeezing the search input away.
  maxWidth: 160,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  fontSize: 13,
  padding: "8px 10px",
  background: "#10151C",
  border: "1px solid #2A2F37",
  borderRadius: 8,
  color: "#E6EDF3",
  outline: "none",
  cursor: "pointer",
};
