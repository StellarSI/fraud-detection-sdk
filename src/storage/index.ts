/**
 * Baseline persistence and storage abstraction (issue #42).
 *
 * Provides a minimal `BaselineStore` interface so baseline models can persist
 * snapshots without depending on a specific backend.
 */

export interface BaselineStore<T = unknown> {
  get(key: string): T | undefined | Promise<T | undefined>;
  put(key: string, value: T): void | Promise<void>;
  delete(key: string): void | Promise<void>;
}

/**
 * Simple in-memory implementation for tests and ephemeral runtime use.
 */
export class InMemoryBaselineStore<T = unknown> implements BaselineStore<T> {
  private readonly store = new Map<string, T>();

  get(key: string): T | undefined {
    return this.store.get(key);
  }

  put(key: string, value: T): void {
    this.store.set(key, value);
  }

  /** Backwards-compatible alias for put. */
  set(key: string, value: T): void {
    this.store.set(key, value);
  }

  delete(key: string): void {
    this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }

  size(): number {
    return this.store.size;
  }
}
