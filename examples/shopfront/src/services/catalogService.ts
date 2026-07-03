import type { Category, Product, ProductId, ProductView } from "../domain/product.js";
import { ProductRepository } from "../repository/productRepository.js";
import { InventoryService } from "./inventoryService.js";
import { formatMoney } from "../utils/legacy.js";
import { log } from "../utils/logger.js";

/** Reads the catalog and shapes it for the UI, folding in live stock signals. */
export class CatalogService {
  constructor(
    private readonly _products: ProductRepository,
    private readonly _inventory: InventoryService,
  ) {}

  /** Every active product, shaped for display. */
  listProducts(): ProductView[] {
    return this._products
      .list()
      .filter((product) => product.active)
      .map((product) => this.toView(product));
  }

  /** One product by id, if it exists. */
  getProduct(id: ProductId): Product | undefined {
    return this._products.findById(id);
  }

  /** Display rows for a single category. */
  byCategory(category: Category): ProductView[] {
    return this._products.findByCategory(category).map((product) => this.toView(product));
  }

  /** Search the catalog and shape the hits for display. */
  search(term: string): ProductView[] {
    log(`catalog search: ${term}`);
    return this._products.search(term).map((product) => this.toView(product));
  }

  /** Shape a product for the UI: format its price and attach a live stock flag. */
  toView(product: Product): ProductView {
    return {
      id: product.id,
      title: product.title,
      category: product.category,
      formattedPrice: formatMoney(product.price),
      inStock: this._inventory.inStock(product.id),
    };
  }
}
