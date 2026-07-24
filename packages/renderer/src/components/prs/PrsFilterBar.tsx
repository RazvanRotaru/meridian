/**
 * The PR list's searchable combobox and author filter. Query text remains ephemeral view state in
 * PrsView, while the store owns remote priority-search results and loading/error state.
 */

export function PrsFilterBar(props: {
  query: string;
  onQueryChange: (value: string) => void;
  onQueryKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => void;
  activeDescendant: string | undefined;
  busy: boolean;
  status: string;
  author: string;
  onAuthorChange: (value: string) => void;
  authors: readonly string[];
}) {
  return (
    <div style={BAR_STYLE}>
      <input
        style={SEARCH_INPUT_STYLE}
        placeholder="Search #, title, author, or branch"
        value={props.query}
        onChange={(event) => props.onQueryChange(event.target.value)}
        onKeyDown={props.onQueryKeyDown}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded="true"
        aria-controls="pr-search-results"
        aria-activedescendant={props.activeDescendant}
        aria-describedby="pr-search-status"
        aria-busy={props.busy}
        aria-label="Search pull requests"
        autoComplete="off"
      />
      <select
        style={SELECT_STYLE}
        value={props.author}
        onChange={(event) => props.onAuthorChange(event.target.value)}
        aria-label="Filter by author"
        disabled={props.authors.length === 0}
      >
        <option value="">All authors</option>
        {props.authors.map((author) => (
          <option key={author} value={author}>
            {author}
          </option>
        ))}
      </select>
      <span id="pr-search-status" style={STATUS_STYLE} role="status" aria-live="polite">
        {props.status}
      </span>
    </div>
  );
}

const BAR_STYLE: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(0, 1fr) minmax(120px, 160px)",
  gap: 8,
  marginBottom: 12,
};
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
const STATUS_STYLE: React.CSSProperties = {
  gridColumn: "1 / -1",
  minHeight: 16,
  color: "#8B949E",
  fontSize: 11.5,
  lineHeight: "16px",
};
