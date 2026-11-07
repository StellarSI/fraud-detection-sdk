/**
 * Feature registry and pluggable feature providers (issue #24).
 *
 * This is the uniform pipeline the architecture diagram shows feeding the
 * rules, statistical, and ML tiers (README.md:84-98): every feature family
 * (velocity #19, graph #20, assets #21, memo #22, lifecycle #23) is a
 * {@link FeatureProvider} and a {@link FeatureRegistry} runs them against
 * one shared {@link FeatureContext}, merging their flat {@link FeatureMap}
 * output for downstream detectors and models.
 *
 * Contract:
 * - Providers are registered by name; duplicate names are rejected so the
 *   pipeline never silently drops one family.
 * - `compute`/`extract` runs enabled providers in registration order and
 *   merges their maps with later providers winning on key collisions.
 *   The merge is deterministic: identical context yields identical output.
 * - Providers are individually toggle-able via the `enabled` option map
 *   or at runtime with {@link FeatureRegistry.setEnabled}. Disabled
 *   providers are skipped before compute, so a disabled family cannot
 *   throw or contribute keys.
 * - A provider that throws propagates its error unchanged (fail fast);
 *   the registry never swallows a failure into a partial map.
 * - The registry is pure with respect to its context: it mutates no
 *   provider state and the same context always merges the same way.
 */

import { ValidationError } from "../errors.js";
import type { FeatureContext, FeatureMap, FeatureProvider } from "./types.js";
import { createVelocityFeatureProvider } from "./velocity.js";
import { createGraphFeatureProvider } from "./graph.js";
import { createAssetFeatureProvider } from "./assets.js";
import { createMemoFeatureProvider } from "./memo.js";
import { createLifecycleFeatureProvider } from "./lifecycle.js";

/** Options for {@link FeatureRegistry}. */
export interface FeatureRegistryOptions {
  /**
   * Providers to register, in merge order. Defaults to the five built-in
   * feature families (velocity, graph, assets, memo, lifecycle).
   */
  readonly providers?: readonly FeatureProvider[];
  /**
   * Per-provider enablement, keyed by provider name. Omitted entries
   * default to enabled. Unknown names are rejected so typos fail loudly.
   */
  readonly enabled?: Readonly<Record<string, boolean>>;
}

function resolveProviderName(provider: FeatureProvider, index: number): string {
  if (!provider || typeof provider !== "object") {
    throw new ValidationError(
      `Feature provider at index ${index} must be an object with a name and compute method`
    );
  }
  if (typeof provider.name !== "string" || provider.name.trim().length === 0) {
    throw new ValidationError(
      `Feature provider at index ${index} must have a non-empty string name`
    );
  }
  if (typeof provider.compute !== "function") {
    throw new ValidationError(
      `Feature provider "${provider.name}" must implement compute(context): FeatureMap`
    );
  }
  return provider.name;
}

function assertFeatureContext(context: FeatureContext): void {
  if (!context || typeof context !== "object") {
    throw new ValidationError(
      "FeatureContext must be an object with transactions, accountId/account, and optional now"
    );
  }
  if (!Array.isArray(context.transactions)) {
    throw new ValidationError("FeatureContext.transactions must be an array");
  }
}

/**
 * Registry that runs pluggable {@link FeatureProvider}s uniformly (#24).
 *
 * ```ts
 * const registry = createDefaultFeatureRegistry({ enabled: { graph: false } });
 * registry.setEnabled("memo", false);
 * const map = registry.compute({ accountId: "G...", account, transactions, now });
 * ```
 */
export class FeatureRegistry {
  private readonly providers = new Map<string, FeatureProvider>();
  private readonly enabledMap = new Map<string, boolean>();

  constructor(options: FeatureRegistryOptions = {}) {
    const providers =
      options.providers ?? createDefaultFeatureProviders();
    providers.forEach((provider, index) => {
      const name = resolveProviderName(provider, index);
      if (this.providers.has(name)) {
        throw new ValidationError(`Duplicate feature provider "${name}"`);
      }
      this.providers.set(name, provider);
      this.enabledMap.set(name, true);
    });

    if (options.enabled !== undefined) {
      if (
        !options.enabled ||
        typeof options.enabled !== "object" ||
        Array.isArray(options.enabled)
      ) {
        throw new ValidationError(
          "enabled must be a record mapping provider names to booleans"
        );
      }
      for (const [name, enabled] of Object.entries(options.enabled)) {
        if (!this.providers.has(name)) {
          throw new ValidationError(
            `Unknown feature provider "${name}" in enabled config. ` +
              `Registered providers: ${this.providerNames().join(", ") || "(none)"}`
          );
        }
        if (typeof enabled !== "boolean") {
          throw new ValidationError(
            `enabled["${name}"] must be a boolean, got ${typeof enabled}`
          );
        }
        this.enabledMap.set(name, enabled);
      }
    }
  }

  /** All registered providers in registration (merge) order. */
  list(): FeatureProvider[] {
    return Array.from(this.providers.values());
  }

  /** Names of all registered providers in registration order. */
  providerNames(): string[] {
    return Array.from(this.providers.keys());
  }

  /** Returns true when a provider with this exact name is registered. */
  has(name: string): boolean {
    return this.providers.has(name);
  }

  /** Returns the provider with this name, or undefined when absent. */
  get(name: string): FeatureProvider | undefined {
    return this.providers.get(name);
  }

  /**
   * Registers another provider.
   *
   * @returns This registry, for chaining.
   * @throws {ValidationError} If the provider is malformed or its name
   *   collides with an existing provider.
   */
  register(provider: FeatureProvider): this {
    const name = resolveProviderName(provider, this.providers.size);
    if (this.providers.has(name)) {
      throw new ValidationError(`Duplicate feature provider "${name}"`);
    }
    this.providers.set(name, provider);
    this.enabledMap.set(name, true);
    return this;
  }

  /**
   * Removes a provider.
   *
   * @returns True when a provider was removed, false when absent.
   */
  unregister(name: string): boolean {
    const removed = this.providers.delete(name);
    if (removed) {
      this.enabledMap.delete(name);
    }
    return removed;
  }

  /** Returns whether the named provider is currently enabled. */
  isEnabled(name: string): boolean {
    if (!this.providers.has(name)) {
      throw new ValidationError(
        `Unknown feature provider "${name}". Registered providers: ${
          this.providerNames().join(", ") || "(none)"
        }`
      );
    }
    return this.enabledMap.get(name) ?? true;
  }

  /**
   * Enables or disables a single provider at runtime.
   *
   * @throws {ValidationError} If the name is unknown or `enabled` is not
   *   a boolean.
   */
  setEnabled(name: string, enabled: boolean): void {
    if (!this.providers.has(name)) {
      throw new ValidationError(
        `Unknown feature provider "${name}". Registered providers: ${
          this.providerNames().join(", ") || "(none)"
        }`
      );
    }
    if (typeof enabled !== "boolean") {
      throw new ValidationError(
        `enabled for "${name}" must be a boolean, got ${typeof enabled}`
      );
    }
    this.enabledMap.set(name, enabled);
  }

  /** Enabled providers in registration order. */
  enabledProviders(): FeatureProvider[] {
    return this.list().filter((provider) => this.enabledMap.get(provider.name));
  }

  /**
   * Runs every enabled provider against the shared context and merges
   * their {@link FeatureMap} outputs. Later providers win on key
   * collisions; registration order fully determines the result.
   *
   * @param context - Shared account, transactions, and reference time.
   * @returns The merged, uniform feature map for downstream models.
   * @throws {ValidationError} If the context is malformed.
   */
  compute(context: FeatureContext): FeatureMap {
    assertFeatureContext(context);
    const merged: FeatureMap = {};
    for (const provider of this.enabledProviders()) {
      const map = provider.compute(context);
      if (!map || typeof map !== "object" || Array.isArray(map)) {
        throw new ValidationError(
          `Feature provider "${provider.name}" must return a FeatureMap object`
        );
      }
      for (const [key, value] of Object.entries(map)) {
        merged[key] = value;
      }
    }
    return merged;
  }

  /** Alias for {@link FeatureRegistry.compute}. */
  extract(context: FeatureContext): FeatureMap {
    return this.compute(context);
  }
}

/** Creates the five built-in feature providers (#19-#23). */
export function createDefaultFeatureProviders(): FeatureProvider[] {
  return [
    createVelocityFeatureProvider(),
    createGraphFeatureProvider(),
    createAssetFeatureProvider(),
    createMemoFeatureProvider(),
    createLifecycleFeatureProvider(),
  ];
}

/** Creates a {@link FeatureRegistry} from registry options. */
export function createFeatureRegistry(
  options: FeatureRegistryOptions = {}
): FeatureRegistry {
  return new FeatureRegistry(options);
}

/**
 * Creates a registry pre-loaded with the five default families (#19-#23)
 * and optional per-provider toggles from `enabled`.
 */
export function createDefaultFeatureRegistry(
  options: FeatureRegistryOptions = {}
): FeatureRegistry {
  return new FeatureRegistry({
    providers: options.providers ?? createDefaultFeatureProviders(),
    enabled: options.enabled,
  });
}

/**
 * Convenience helper: extracts features with the default registry.
 *
 * @param context - Shared feature context.
 * @param registry - Registry to run; defaults to a fresh default registry.
 * @returns The merged {@link FeatureMap}.
 */
export function extractFeatures(
  context: FeatureContext,
  registry: FeatureRegistry = createDefaultFeatureRegistry()
): FeatureMap {
  return registry.compute(context);
}
