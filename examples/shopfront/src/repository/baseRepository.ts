/**
 * A shared in-memory store. Concrete repositories extend this to get save/findById/list for
 * free, which gives the graph a small inheritance fan-in on one base class.
 */

import { deepClone } from "../utils/clone.js";
import { log } from "../utils/logger.js";

/** Anything with a string `id` can live in the base store. */
export interface Entity {
  id: string;
}

/** Generic map-backed repository. Not meant to be used directly. */
export abstract class BaseRepository<T extends Entity> {
  private readonly byId = new Map<string, T>();

  /** Persist an entity, cloning it so callers cannot mutate our copy. */
  save(entity: T): T {
    this.byId.set(entity.id, deepClone(entity));
    log(`${this.label()} saved ${entity.id}`);
    return entity;
  }

  /** Look one entity up by id. */
  findById(id: string): T | undefined {
    return this.byId.get(id);
  }

  /** Every entity currently held, as a fresh array. */
  list(): T[] {
    return [...this.byId.values()];
  }

  /** How many entities are stored. */
  count(): number {
    return this.byId.size;
  }

  /** A human label for log lines; subclasses name themselves. */
  protected abstract label(): string;
}
