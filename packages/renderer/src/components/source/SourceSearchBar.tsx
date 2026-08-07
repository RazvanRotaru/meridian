import {
  ChevronDownIcon,
  ChevronUpIcon,
  Cross2Icon,
  MagnifyingGlassIcon,
} from "@radix-ui/react-icons";
import type { SourceSearchController } from "./useSourceSearch";

export const SOURCE_SEARCH_ID = "meridian-source-search";

export function SourceSearchBar({ search }: { search: SourceSearchController }) {
  return (
    <div
      id={SOURCE_SEARCH_ID}
      role="search"
      aria-label="Find in current source"
      style={SEARCH_BAR_STYLE}
      data-source-search="true"
    >
      <style>{SOURCE_SEARCH_CSS}</style>
      <MagnifyingGlassIcon aria-hidden="true" style={SEARCH_ICON_STYLE} />
      <input
        ref={search.inputRef}
        className="source-dock-search-input"
        type="search"
        value={search.query}
        aria-label="Search source"
        aria-controls="meridian-source-code-dock"
        placeholder="Find in current source"
        autoComplete="off"
        spellCheck={false}
        style={SEARCH_INPUT_STYLE}
        onChange={(event) => search.setQuery(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            search.move(event.shiftKey ? -1 : 1);
          } else if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            search.close();
          }
        }}
      />
      <span
        role="status"
        aria-live="polite"
        aria-atomic="true"
        style={SEARCH_STATUS_STYLE}
        data-source-search-status="true"
      >
        {search.query.length === 0
          ? "Type to search"
          : search.matches.length === 0
            ? "No matches"
            : `${search.activeIndex + 1} of ${search.matches.length}${search.result.truncated ? "+" : ""} · L${search.activeMatch?.line}:${search.activeMatch?.column}`}
      </span>
      <button
        type="button"
        style={SEARCH_ACTION_STYLE}
        disabled={search.matches.length === 0}
        aria-label="Previous source match"
        title="Previous match (Shift+Enter)"
        onClick={() => search.move(-1)}
      >
        <ChevronUpIcon />
      </button>
      <button
        type="button"
        style={SEARCH_ACTION_STYLE}
        disabled={search.matches.length === 0}
        aria-label="Next source match"
        title="Next match (Enter)"
        onClick={() => search.move(1)}
      >
        <ChevronDownIcon />
      </button>
      <button
        type="button"
        style={SEARCH_ACTION_STYLE}
        aria-label="Close source search"
        title="Close search (Escape)"
        onClick={() => search.close()}
      >
        <Cross2Icon />
      </button>
    </div>
  );
}

const SOURCE_SEARCH_CSS = `
.source-dock-search-input:focus-visible {
  outline: 2px solid #58A6FF;
  outline-offset: -1px;
  border-color: #58A6FF;
}`;

const SEARCH_BAR_STYLE: React.CSSProperties = {
  flex: "0 0 auto",
  minHeight: 38,
  display: "flex",
  alignItems: "center",
  gap: 6,
  boxSizing: "border-box",
  padding: "5px 10px",
  borderBottom: "1px solid #2A2F37",
  background: "#10151C",
};

const SEARCH_ICON_STYLE: React.CSSProperties = {
  flex: "0 0 auto",
  color: "#7B8695",
};

const SEARCH_INPUT_STYLE: React.CSSProperties = {
  flex: "1 1 180px",
  minWidth: 110,
  height: 27,
  boxSizing: "border-box",
  padding: "4px 8px",
  border: "1px solid #364252",
  borderRadius: 5,
  background: "#0E1116",
  color: "#E6EDF3",
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  fontSize: 11.5,
};

const SEARCH_STATUS_STYLE: React.CSSProperties = {
  flex: "0 0 auto",
  minWidth: 92,
  color: "#91A5BC",
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  fontSize: 10.5,
  textAlign: "right",
  whiteSpace: "nowrap",
};

const SEARCH_ACTION_STYLE: React.CSSProperties = {
  flex: "0 0 auto",
  width: 25,
  height: 25,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 0,
  border: "1px solid #303844",
  borderRadius: 5,
  background: "#1A1F27",
  color: "#9AA4B2",
  cursor: "pointer",
};
