/**
 * Reused-memo-ID detector rule (issue #33).
 *
 * Targets the Stellar-specific pattern where a single memo value —
 * typically a numeric `id` memo — is reused across many transactions
 * (README.md:21). Reused memo IDs are a concrete, testable signal of
 * coordinated or automated activity (e.g. a bot replaying the same
 * deposit reference). Consumes memo features (#22) and emits a
 * `reused-memo-id` signal scaled by how far the reuse exceeds the
 * configured threshold.
 *
 * Memo values are missing or optional on most Stellar transactions:
 * accounts with no memo activity (or mostly-unique memos) produce no
 * signal, so legitimate anchor deposits and human senders are not
 * mislabeled. Thresholds are configurable so operators can tune
 * sensitivity per environment.
 */

import type { Signal } from "../types.js";
import type { Rule, RuleContext } from "./engine.js";
import { ValidationError } from "../errors.js";

/** Default rule weight (engine contribution) in [0, 1]. */
export const DEFAULT_REUSED_MEMO_ID_RULE_WEIGHT = 0.5;

/** Default minimum severity required to emit a signal. */
export const DEFAULT_REUSED_MEMO_ID_MIN_SCORE = 0.05;

/**
 * Default minimum number of times a single memo `id` value must repeat
 * before this rule flags the account. Reuse at or beyond this count
 * emits a signal; anything below stays quiet.
 */
export const DEFAULT_REUSED_MEMO_ID_REUSE_THRESHOLD = 3;

/** Default minimum number of distinct reused `id` memos that strengthens the signal. */
export const DEFAULT_REUSED_MEMO_ID_DISTINCT_THRESHOLD = 1;

export interface ReusedMemoIdRuleOptions {
  /**
   * Base rule weight (engine contribution) in [0, 1].
   * The emitted signal weight scales by severity; the engine combines them.
   */
  readonly weight?: number;
  /** Minimum severity score required to emit a signal. Default: 0.05. */
  readonly minScore?: number;
  /**
   * Minimum reuse count of a single memo `id` value required to flag the
   * account. Must be a positive integer. Default: 3.
   */
  readonly reuseThreshold?: number;
  /**
   * Minimum number of distinct memo `id` values reused at least
   * `reuseThreshold` times before the distinct-value bonus applies.
   * Must be a positive integer. Default: 1.
   */
  readonly distinctReuseThreshold?: number;
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

function resolvePositiveInteger(
  value: number | undefined,
  fallback: number,
  label: string
): number {
  const resolved = resolveNumber(value, fallback, label);
  if (!Number.isInteger(resolved) || resolved < 1) {
    throw new ValidationError(`${label} must be a positive integer`);
  }
  return resolved;
}

function num(context: RuleContext, key: string): number {
  const value = context[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Creates the reused-memo-ID rule.
 *
 * Reads features produced by `extractMemoFeatures` /
 * `createMemoFeatureProvider` (#22): `memoPresentCount`,
 * `memoIdCount`, `memoReusedIdCount`, `memoMaxIdReuseCount`, and
 * `memoReuseShare`.
 *
 * Severity (and thus signal weight) scales with the worst reuse count,
 * the number of distinct reused `id` memos, and the share of memo-bearing
 * transactions whose memo repeats. Accounts with no memo activity emit
 * nothing.
 */
export function createReusedMemoIdRule(
  options: ReusedMemoIdRuleOptions = {}
): Rule {
  const weight = resolveNumber(options.weight, DEFAULT_REUSED_MEMO_ID_RULE_WEIGHT, "weight");
  const minScore = resolveNumber(options.minScore, DEFAULT_REUSED_MEMO_ID_MIN_SCORE, "minScore");
  if (minScore < 0 || minScore > 1) {
    throw new ValidationError("minScore must be in [0, 1]");
  }
  const reuseThreshold = resolvePositiveInteger(
    options.reuseThreshold,
    DEFAULT_REUSED_MEMO_ID_REUSE_THRESHOLD,
    "reuseThreshold"
  );
  const distinctReuseThreshold = resolvePositiveInteger(
    options.distinctReuseThreshold,
    DEFAULT_REUSED_MEMO_ID_DISTINCT_THRESHOLD,
    "distinctReuseThreshold"
  );

  return {
    id: "reused-memo-id",
    weight,
    evaluate(context: RuleContext): Signal | null {
      const memoPresentCount = num(context, "memoPresentCount");
      const memoIdCount = num(context, "memoIdCount");
      const maxIdReuseCount = num(context, "memoMaxIdReuseCount");
      // Missing/optional memos are the common case: nothing to flag.
      if (memoPresentCount <= 0 || memoIdCount <= 0 || maxIdReuseCount < reuseThreshold) {
        return null;
      }

      const reusedIdCount = num(context, "memoReusedIdCount");
      const reuseShare = Math.min(Math.max(num(context, "memoReuseShare"), 0), 1);

      // More reuse beyond the threshold and more distinct reused values
      // both strengthen the signal; global reuse share adds corroboration.
      const overshoot = Math.min(
        (maxIdReuseCount - reuseThreshold) / (reuseThreshold * 2),
        1
      );
      const reuseFactor = Math.min(maxIdReuseCount / (reuseThreshold * 3), 1);
      const distinctFactor = Math.min(
        reusedIdCount / (distinctReuseThreshold * 3),
        1
      );
      const severity = Math.min(
        reuseFactor * 0.5 + overshoot * 0.2 + distinctFactor * 0.2 + reuseShare * 0.1,
        1
      );

      if (severity < minScore) {
        return null;
      }

      return {
        id: "reused-memo-id",
        weight: Math.round(Math.min(Math.max(severity, 0), 1) * 10_000) / 10_000,
        detail:
          `Reused memo id indicators: a single memo id value repeats ${maxIdReuseCount} ` +
          `time(s) across ${memoIdCount} id-memo transaction(s) ` +
          `(${reusedIdCount} distinct reused id memo(s); ${Math.round(reuseShare * 100)}% of memo-bearing transactions reuse a memo)`,
      };
    },
  };
}

export default createReusedMemoIdRule;
