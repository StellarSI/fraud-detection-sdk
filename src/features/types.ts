/**
 * Shared feature-extraction contracts (issues #19, #20, #24).
 *
 * Feature families such as velocity and graph expose a
 * {@link FeatureProvider} so a registry (#24) can run them uniformly and
 * merge their flat {@link FeatureMap} output for downstream detectors
 * and models.
 */

import type { Account, Transaction } from "../clients/horizon.js";

/** A single scalar feature value in a merged feature map. */
export type FeatureValue = number | string | boolean | null;

/** Flat, model-friendly output produced by a feature provider. */
export type FeatureMap = Record<string, FeatureValue>;

/**
 * Input shared by every feature provider.
 *
 * The account is optional because some families can compute
 * account-independent aggregates; providers that need it should reject
 * a missing value with a clear `ValidationError`.
 */
export interface FeatureContext {
  /** Account whose behavior is being described, when scoring one account. */
  readonly accountId?: string;
  /** Normalized account being scored (issue #12), consumed by asset/lifecycle providers. */
  readonly account?: Account;
  /** Normalized transaction history (see clients/horizon, issue #13). */
  readonly transactions: readonly Transaction[];
  /** Reference time for windowed features; defaults to the current time. */
  readonly now?: Date | string | number;
}

/**
 * A pluggable feature family (#24).
 *
 * `compute` must be pure with respect to its context: the same input
 * yields the same map, so scores stay reproducible.
 */
export interface FeatureProvider {
  /** Stable provider name, e.g. "velocity" or "graph". */
  readonly name: string;
  /** Computes this family's features for the supplied context. */
  compute(context: FeatureContext): FeatureMap;
}
