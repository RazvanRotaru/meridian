import type { ReactElement } from "react";
import type { ProductId } from "../domain/product.js";
import type { SavedProduct } from "../domain/savedList.js";

/** Props for the shopper's save-for-later summary. */
export interface SavedItemsPanelProps {
  items: SavedProduct[];
  onRemove(productId: ProductId): void;
}

/** Compact list of saved products, kept beside the catalog for quick return. */
export function SavedItemsPanel({ items, onRemove }: SavedItemsPanelProps): ReactElement {
  return (
    <aside className="saved-items-panel" aria-label="Saved for later">
      <h2>Saved for later</h2>
      {items.length === 0 ? (
        <p>Products you save will appear here.</p>
      ) : (
        <ul>
          {items.map((item) => (
            <li key={item.productId}>
              <span>{item.title}</span>
              <span>{item.formattedPrice}</span>
              <button type="button" onClick={() => onRemove(item.productId)}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}
