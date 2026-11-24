/**
 * Unified model plugin contract (issue #43).
 *
 * The README promises "pluggable models": rules (#25), statistical (#41)
 * and ML (#49) must be usable together and independently swappable. This
 * module defines the single interface each tier adapts to so the scoring
 * pipeline can treat every model the same way.
 *
 * Contract:
 * - `id` is a stable, non-empty identifier used by registries and logs.
 * - `score(context): Promise<Signal[]>` is **always asynchronous**, so ML
 *   inference and network-backed models have the same shape as local rules.
 * - `configure(opts)` applies runtime options; unknown keys are ignored by
 *   adapters that do not understand them, while invalid known values throw
 *   the SDK's `ValidationError`.
 * - Scoring is pure with respect to the context: identical inputs yield
 *   identical signals for a given configuration.
 *
 * Typed with JSDoc so the contract is picked up by the eventual TypeDoc
 * reference (issue #99).
 */

import type { FeatureContext, FeatureMap } from "../features/types.js";
import type { Signal } from "../types.js";

/**
 * Input shared by every model plugin.
 *
 * Extends {@link FeatureContext} so a plugin can compute features itself.
 * `features` short-circuits that work when a caller has already run the
 * feature registry (#24); `baselineSamples` feeds statistical models (#41).
 */
export interface ModelContext extends FeatureContext {
  /** Pre-computed merged features; when set, plugins must not re-extract. */
  readonly features?: FeatureMap;
  /** Per-feature numeric baseline samples used by statistical models. */
  readonly baselineSamples?: Readonly<Record<string, readonly number[]>>;
}

/** Runtime options accepted by {@link ModelPlugin.configure}. */
export interface ModelPluginOptions {
  /** Whether the plugin should contribute signals. Defaults to true. */
  readonly enabled?: boolean;
  /** Multiplier applied to every emitted signal weight, clamped to [0, 1]. */
  readonly weight?: number;
  /** Tier-specific options (sensitivity, thresholds, model version, ...). */
  readonly [key: string]: unknown;
}

/**
 * A pluggable model from any tier.
 *
 * ```ts
 * const plugin: ModelPlugin = {
 *   id: "my-model",
 *   async score(context) {
 *     return [{ id: "my-model", weight: 0.4 }];
 *   },
 *   configure(options) { void options; },
 * };
 * ```
 */
export interface ModelPlugin {
  /** Stable plugin identifier, unique within a registry. */
  readonly id: string;
  /** Scores one context and returns weighted signals asynchronously. */
  score(context: ModelContext): Promise<Signal[]>;
  /** Applies runtime options; invalid known values throw `ValidationError`. */
  configure(options: ModelPluginOptions): void;
}

/** Type guard used by registries and conformance tests. */
export function isModelPlugin(value: unknown): value is ModelPlugin {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ModelPlugin>;
  return (
    typeof candidate.id === "string" &&
    candidate.id.trim().length > 0 &&
    typeof candidate.score === "function" &&
    typeof candidate.configure === "function"
  );
}

/* eslint-disable @typescript-eslint/no-unused-vars */
// Type-level contract tests: adapters must satisfy the shape exactly.
type _Assert<T extends true> = T;
type _ContextExtendsFeatureContext = _Assert<ModelContext extends FeatureContext ? true : false>;
type _SignalsAreSignals = _Assert<Awaited<ReturnType<ModelPlugin["score"]>> extends Signal[] ? true : false>;
