/**
 * Counterparty-cluster detector rule (issue #44).
 *
 * Consumes the clustering features produced by `createClusteringFeatureProvider`
 * (#44) and emits a single `counterparty-cluster` signal when the scored
 * account belongs to a tight cluster. A tight cluster is one that clears
 * both the feature-level size/density test and this rule's own minimums, so
 * a large but sparse component (for example a star) does not raise a signal
 * on its own.
 */

import { ValidationError } from "../errors.js";
import type { Signal } from "../types.js";
import type { Rule, RuleContext } from "./engine.js";

/** Default rule weight (engine contribution) in [0, 1]. */
export const DEFAULT_COUNTERPARTY_CLUSTER_RULE_WEIGHT = 0.55;

/** Default minimum severity required to emit a signal. */
export const DEFAULT_COUNTERPARTY_CLUSTER_MIN_SCORE = 0.05;

/** Default minimum cluster size required to emit a signal. */
export const DEFAULT_COUNTERPARTY_CLUSTER_MIN_SIZE = 3;

/** Default minimum cluster density required to emit a signal. */
export const DEFAULT_COUNTERPARTY_CLUSTER_MIN_DENSITY = 0.75;

/** Options for {@link createCounterpartyClusterRule}. */
export interface CounterpartyClusterRuleOptions {
  /** Base rule weight in [0, 1]. Default: 0.55. */
  readonly weight?: number;
  /** Minimum severity required to emit. Default: 0.05. */
  readonly minScore?: number;
  /** Minimum cluster size. Must be >= 1. Default: 3. */
  readonly minSize?: number;
  /** Minimum cluster density in [0, 1]. Default: 0.75. */
  readonly minDensity?: number;
}

function resolveNumber(value: number | undefined, fallback: number, label: string): number {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ValidationError(`${label} must be a finite number`);
  }
  return value;
}

function resolvePositiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new ValidationError(`${label} must be a positive integer`);
  }
  return value;
}

function numberInContext(context: RuleContext, key: string): number | undefined {
  const value = context[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }
  if (value >= 1) {
    return 1;
  }
  return Math.round(value * 10_000) / 10_000;
}

/**
 * Creates the counterparty-cluster rule.
 *
 * Reads `clusterId`, `clusterSize`, `clusterDensity`, and `clusterIsTight`
 * from the merged feature map. Missing or non-numeric values yield no
 * signal, so the rule is safe to run with a partial feature registry.
 */
export function createCounterpartyClusterRule(
  options: CounterpartyClusterRuleOptions = {}
): Rule {
  const weight = resolveNumber(
    options.weight,
    DEFAULT_COUNTERPARTY_CLUSTER_RULE_WEIGHT,
    "weight"
  );
  const minScore = resolveNumber(
    options.minScore,
    DEFAULT_COUNTERPARTY_CLUSTER_MIN_SCORE,
    "minScore"
  );
  if (minScore < 0 || minScore > 1) {
    throw new ValidationError("minScore must be in [0, 1]");
  }
  const minSize = options.minSize === undefined
    ? DEFAULT_COUNTERPARTY_CLUSTER_MIN_SIZE
    : resolvePositiveInteger(options.minSize, "minSize");
  const minDensity = resolveNumber(
    options.minDensity,
    DEFAULT_COUNTERPARTY_CLUSTER_MIN_DENSITY,
    "minDensity"
  );
  if (minDensity < 0 || minDensity > 1) {
    throw new ValidationError("minDensity must be in [0, 1]");
  }

  return {
    id: "counterparty-cluster",
    weight,
    evaluate(context: RuleContext): Signal | null {
      const isTight = context["clusterIsTight"] === true;
      const size = numberInContext(context, "clusterSize") ?? 0;
      const density = numberInContext(context, "clusterDensity") ?? 0;
      if (!isTight || size < minSize || density < minDensity) {
        return null;
      }

      const severity = clamp01(
        Math.min(1, (size / (minSize * 2)) * 0.5 + density * 0.5)
      );
      if (severity < minScore) {
        return null;
      }

      const clusterId = typeof context["clusterId"] === "string" ? context["clusterId"] : "";
      return {
        id: "counterparty-cluster",
        weight: severity,
        detail:
          `Account belongs to a tight counterparty cluster ` +
          `(${size} members, density ${density})` +
          (clusterId.length > 0 ? ` [${clusterId}]` : ""),
      };
    },
  };
}

export default createCounterpartyClusterRule;
