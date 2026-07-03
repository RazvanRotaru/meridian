import type { CatalogService, RecommendationService } from "../services/index.js";
import { type ApiResponse, ok } from "./response.js";
import { log } from "../utils/logger.js";

/** HTTP front door for the catalog. Imports its services through the barrel. */
export class CatalogRoutes {
  constructor(
    private readonly _catalog: CatalogService,
    private readonly _recommendations: RecommendationService,
  ) {}

  /** GET /products — list every active product. */
  handleListProducts(): ApiResponse {
    return ok(this._catalog.listProducts());
  }

  /** GET /products/:id — one product plus its recommendations. */
  handleGetProduct(id: string): ApiResponse {
    const product = this._catalog.getProduct(id);
    if (!product) {
      return { status: 404, body: { error: "not found" } };
    }
    return ok({ product, related: this._recommendations.recommend(id) });
  }

  /** GET /products?q= — search the catalog. */
  handleSearch(term: string): ApiResponse {
    log(`GET /products?q=${term}`);
    return ok(this._catalog.search(term));
  }
}
