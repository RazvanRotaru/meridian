import type { ProductId, ProductView } from "../domain/product.js";
import { ProductRepository } from "../repository/productRepository.js";
import { CatalogService } from "./catalogService.js";
import { groupBy, unique } from "../utils/collections.js";
import { log } from "../utils/logger.js";

/**
 * Suggests products. Overlaps intentionally with CatalogService — it cross-calls it for
 * shaping and listing rather than owning its own view logic.
 */
export class RecommendationService {
  constructor(
    private readonly _products: ProductRepository,
    private readonly _catalog: CatalogService,
  ) {}

  /** Products related to a seed product, falling back to popular picks. */
  recommend(seedId: ProductId): ProductView[] {
    const seed = this._catalog.getProduct(seedId);
    if (!seed) {
      log(`no seed product ${seedId}`, "warn");
      return this.popular();
    }
    return this._products
      .findByCategory(seed.category)
      .filter((product) => product.id !== seedId)
      .map((product) => this._catalog.toView(product));
  }

  /** A generic "popular" shelf: the first few catalog rows. */
  popular(): ProductView[] {
    return this._catalog.listProducts().slice(0, 4);
  }

  /** Product counts per category, for a merchandising dashboard. */
  byCategoryCounts(): Record<string, number> {
    const grouped = groupBy(this._products.list(), (product) => product.category);
    const out: Record<string, number> = {};
    for (const key of unique(Object.keys(grouped))) {
      out[key] = grouped[key].length;
    }
    return out;
  }
}
