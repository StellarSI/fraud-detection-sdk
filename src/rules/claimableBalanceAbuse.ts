/**
 * Claimable-balance abuse detector rule (issue #31).
 *
 * Targets the Stellar abuse pattern where an account creates
 * `create_claimable_balance` operations whose balances are never claimed,
 * or creates them en masse (README.md:20). Consumes claimable-balance
 * features (#31/#32) and emits a `claimable-balance-abuse` signal scaled
 * by count, claim age, and burst activity.
 *
 * Legitimate balances that are claimed promptly, or a small number of
 * created balances without staleness, emit no signal. Thresholds are
 * configurable so operators can tune sensitivity per network/environment.
 */

import type { Signal } from "../types.js";
import type { Rule, RuleContext } from "./engine.js";
import { ValidationError } from "../errors.js";

/** Default rule weight (engine contribution) in [0, 1]. */
export const DEFAULT_CLAIMABLE_BALANCE_ABUSE_RULE_WEIGHT = 0.6;

/** Default minimum severity required to emit a signal. */
export const DEFAULT_CLAIMABLE_BALANCE_ABUSE_MIN_SCORE = 0.05;

/** Default created-balance count treated as extreme mass creation. */
export const DEFAULT_CLAIMABLE_BALANCE_ABUSE_EXTREME_COUNT = 20;

/** Default `create_claimable_balance` count inside the burst window that is a burst. */
export const DEFAULT_CLAIMABLE_BALANCE_ABUSE_BURST_THRESHOLD = 5;

/** Default unclaimed ratio at/above which stale balances dominate the signal. */
export const DEFAULT_CLAIMABLE_BALANCE_ABUSE_UNCLAIMED_RATIO = 0.5;

export interface ClaimableBalanceAbuseRuleOptions {
  /**
   * Base rule weight (engine contribution) in [0, 1].
   * The emitted signal weight scales by severity; the engine combines them.
   */
  readonly weight?: number;
  /** Minimum severity score required to emit a signal. Default: 0.05. */
  readonly minScore?: number;
  /** Created-balance count treated as extreme. Default: 20. */
  readonly extremeCount?: number;
  /** Created balances in the burst window that count as a burst. Default: 5. */
  readonly burstThreshold?: number;
  /** Unclaimed ratio treated as significant staleness. Default: 0.5. */
  readonly unclaimedRatioThreshold?: number;
}

function resolveNumber(
  value: number | undefined,
  fallback: number,
  label: string
): number {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ValidationError(`${label} must be a finite number`);
  }
  return value;
}

function resolvePositive(
  value: number | undefined,
  fallback: number,
  label: string
): number {
  const resolved = resolveNumber(value, fallback, label);
  if (resolved <= 0) {
    throw new ValidationError(`${label} must be a positive finite number`);
  }
  return resolved;
}

function resolveRatio(
  value: number | undefined,
  fallback: number,
  label: string
): number {
  const resolved = resolveNumber(value, fallback, label);
  if (resolved < 0 || resolved > 1) {
    throw new ValidationError(`${label} must be a number in [0, 1]`);
  }
  return resolved;
}

function num(context: RuleContext, key: string): number {
  const value = context[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function bool(context: RuleContext, key: string): boolean {
  return context[key] === true;
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
 * Creates the claimable-balance abuse rule.
 *
 * Reads features produced by `extractClaimableBalanceFeatures` /
 * `createClaimableBalanceFeatureProvider` (#31):
 * `claimableBalanceCreatedCount`, `claimableBalanceClaimantsCount`,
 * `claimableBalanceBurstCount`, `claimableBalanceUnclaimedCount`,
 * `claimableBalanceUnclaimedRatio`, `claimableBalanceClaimObservedCount`,
 * and `claimableBalanceAbuseScore`.
 *
 * Severity (and thus signal weight) scales with created-balance count,
 * stale unclaimed balances, and burst activity. Balances that are
 * created and claimed promptly contribute nothing.
 */
export function createClaimableBalanceAbuseRule(
  options: ClaimableBalanceAbuseRuleOptions = {}
): Rule {
  const weight = resolveNumber(
    options.weight,
    DEFAULT_CLAIMABLE_BALANCE_ABUSE_RULE_WEIGHT,
    "weight"
  );
  const minScore = resolveNumber(
    options.minScore,
    DEFAULT_CLAIMABLE_BALANCE_ABUSE_MIN_SCORE,
    "minScore"
  );
  const extremeCount = resolvePositive(
    options.extremeCount,
    DEFAULT_CLAIMABLE_BALANCE_ABUSE_EXTREME_COUNT,
    "extremeCount"
  );
  const burstThreshold = resolvePositive(
    options.burstThreshold,
    DEFAULT_CLAIMABLE_BALANCE_ABUSE_BURST_THRESHOLD,
    "burstThreshold"
  );
  const unclaimedRatioThreshold = resolveRatio(
    options.unclaimedRatioThreshold,
    DEFAULT_CLAIMABLE_BALANCE_ABUSE_UNCLAIMED_RATIO,
    "unclaimedRatioThreshold"
  );

  return {
    id: "claimable-balance-abuse",
    weight,
    evaluate(context: RuleContext): Signal | null {
      const created = num(context, "claimableBalanceCreatedCount");
      if (created <= 0) {
        return null;
      }

      const unclaimed = num(context, "claimableBalanceUnclaimedCount");
      const unclaimedRatio = num(context, "claimableBalanceUnclaimedRatio");
      const claimants = num(context, "claimableBalanceClaimantsCount");
      const burst = num(context, "claimableBalanceBurstCount");
      const burstDetected =
        bool(context, "claimableBalanceBurstDetected") ||
        burst >= burstThreshold;
      const extremeDetected =
        bool(context, "claimableBalanceExtremeCountDetected") ||
        created >= extremeCount;
      const featureScore = num(context, "claimableBalanceAbuseScore");
      const effectiveUnclaimedRatio =
        unclaimedRatio > 0
          ? unclaimedRatio
          : created > 0
            ? clamp01(unclaimed / created)
            : 0;

      const countFactor = clamp01(created / extremeCount);
      const unclaimedFactor = clamp01(
        effectiveUnclaimedRatio / Math.max(unclaimedRatioThreshold, 1e-9)
      );
      const burstFactor = clamp01(burst / burstThreshold);
      const claimantFactor = clamp01(claimants / extremeCount);

      const severity = Math.max(
        featureScore,
        clamp01(
          countFactor * 0.3 +
            unclaimedFactor * 0.4 +
            burstFactor * 0.2 +
            claimantFactor * 0.1
        )
      );

      if (severity < minScore) {
        return null;
      }

      const reasons: string[] = [];
      if (extremeDetected) {
        reasons.push(
          `${created} claimable balances created (extreme threshold ${extremeCount})`
        );
      } else {
        reasons.push(`${created} claimable balances created`);
      }
      if (unclaimed > 0) {
        reasons.push(
          `${unclaimed} unclaimed after the staleness threshold (${Math.round(
            effectiveUnclaimedRatio * 100
          )}% of created)`
        );
      }
      if (burstDetected && burst > 0) {
        reasons.push(
          `${burst} create_claimable_balance operations in a short burst (threshold ${burstThreshold})`
        );
      }
      if (reasons.length === 0) {
        reasons.push(`${created} created balances with no observed claims`);
      }

      return {
        id: "claimable-balance-abuse",
        weight: Math.round(Math.min(Math.max(severity, 0), 1) * 10_000) / 10_000,
        detail: `Claimable balance abuse indicators: ${reasons.join(", ")}`,
      };
    },
  };
}

export default createClaimableBalanceAbuseRule;
