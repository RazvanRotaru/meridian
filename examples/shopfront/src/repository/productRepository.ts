import type { Category, Product } from "../domain/product.js";
import { BaseRepository } from "./baseRepository.js";
import { unique } from "../utils/collections.js";

/** Stores the product catalog in memory. */
export class ProductRepository extends BaseRepository<Product> {
  /** All products in a given category. */
  findByCategory(category: Category): Product[] {
    return this.list().filter((product) => product.category === category);
  }

  /** The distinct set of categories that currently have products. */
  categories(): Category[] {
    return unique(this.list().map((product) => product.category));
  }

  /** Full-text-ish search over titles and tags. */
  search(term: string): Product[] {
    const needle = term.toLowerCase();
    return this.list().filter(
      (product) =>
        product.title.toLowerCase().includes(needle) ||
        product.tags.some((tag) => tag.toLowerCase().includes(needle)),
    );
  }

  /** Name used in base-class log lines. */
  protected label(): string {
    return "ProductRepository";
  }
}
