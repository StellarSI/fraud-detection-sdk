/**
 * Throwaway-account and rapid-merge detector rule (issue #29).
 *
 * Targets the Stellar lifecycle pattern where a young account is merged
 * quickly after creation/funding, often used to obscure fund flow
 * (README.md). Consumes lifecycle features (#23) and emits a
 * `throwaway-account` signal when the account is both young and rapidly
 * merged.
 *
 * Age and merge thresholds are configurable so operators can tune
 * sensitivity and avoid flagging legitimate migrations (e.g. older
 * accounts or merges long after creation).
 */

import type { Signal } from "../types.js";
import type { Rule, RuleContext } from "./engine.js";
import { ValidationError } from "../errors.js";

/** Default rule weight (engine contribution) in [0, 1]. */
export const DEFAULT_THROWAWAY_MERGE_RULE_WEIGHT = 0.55;

/** Default maximum account age (ms) for an account to be considered young: 30 days. */
export const DEFAULT_YOUNG_ACCOUNT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** Default maximum time from creation/first-seen to first merge (ms): 7 days. */
export const DEFAULT_MAX_MS_TO_FIRST_MERGE = 7 * 24 * 60 * 60 * 1000;

/** Default minimum merge operations required to emit a signal. */
export const DEFAULT_MIN_MERGE_COUNT = 1;

/** Default minimum severity required to emit a signal. */
export const DEFAULT_THROWAWAY_MERGE_MIN_SCORE = 0.05;

export interface ThrowawayMergeRuleOptions {
  /**
   * Base rule weight (engine contribution) in [0, 1].
   * The emitted signal weight scales by severity; the engine combines them.
   */
  readonly weight?: number;
  /** Maximum account age (ms) treated as "young". Default: 30 days. */
  readonly youngAccountMaxAgeMs?: number;
  /**
   * Maximum milliseconds from creation/first-seen to the first merge that
   * counts as "rapidly merged". Default: 7 days.
   */
  readonly maxMsToFirstMergeMs?: number;
  /** Minimum merge operations required. Default: 1. */
  readonly minMergeCount?: number;
  /** Minimum severity score required to emit a signal. Default: 0.05. */
  readonly minScore?: number;
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

function num(context: RuleContext, key: string): number | undefined {
  const value = context[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Creates the throwaway-account / rapid-merge rule.
 *
 * Reads lifecycle features produced by `extractLifecycleFeatures` /
 * `createLifecycleFeatureProvider` (#23): `accountAgeMs`,
 * `accountMergeCount`, and `msToFirstMerge`.
 *
 * A signal is emitted only when the account is young, has at least the
 * configured merge count, and its first merge occurred within the
 * configured rapid window. Older accounts and merges long after creation
 * do not emit a signal, avoiding false positives for legitimate migrations.
 */
export function createThrowawayMergeRule(
  options: ThrowawayMergeRuleOptions = {}
): Rule {
  const weight = resolveNumber(
    options.weight,
    DEFAULT_THROWAWAY_MERGE_RULE_WEIGHT,
    "weight"
  );
  const youngAccountMaxAgeMs = resolvePositive(
    options.youngAccountMaxAgeMs,
    DEFAULT_YOUNG_ACCOUNT_MAX_AGE_MS,
    "youngAccountMaxAgeMs"
  );
  const maxMsToFirstMergeMs = resolvePositive(
    options.maxMsToFirstMergeMs,
    DEFAULT_MAX_MS_TO_FIRST_MERGE,
    "maxMsToFirstMergeMs"
  );
  const minMergeCount = Math.max(
    0,
    Math.floor(resolveNumber(options.minMergeCount, DEFAULT_MIN_MERGE_COUNT, "minMergeCount"))
  );
  const minScore = resolveNumber(
    options.minScore,
    DEFAULT_THROWAWAY_MERGE_MIN_SCORE,
    "minScore"
  );

  return {
    id: "throwaway-account",
    weight,
    evaluate(context: RuleContext): Signal | null {
      const mergeCount = num(context, "accountMergeCount");
      if (mergeCount === undefined || mergeCount < minMergeCount) {
        return null;
      }

      const ageMs = num(context, "accountAgeMs");
      const msToFirstMerge = num(context, "msToFirstMerge");
      if (ageMs === undefined || msToFirstMerge === undefined) {
        return null;
      }

      const isYoung = ageMs <= youngAccountMaxAgeMs;
      const isRapid = msToFirstMerge <= maxMsToFirstMergeMs;
      if (!isYoung || !isRapid) {
        return null;
      }

      const ageFactor = 1 - Math.min(ageMs / youngAccountMaxAgeMs, 1);
      const rapidFactor = 1 - Math.min(msToFirstMerge / maxMsToFirstMergeMs, 1);
      const mergeFactor = Math.min(mergeCount / Math.max(minMergeCount, 1), 3) / 3;
      const severity = Math.min(
        Math.max(ageFactor * 0.45 + rapidFactor * 0.4 + mergeFactor * 0.15, 0),
        1
      );

      if (severity < minScore) {
        return null;
      }

      const ageHours = Math.round((ageMs / (60 * 60 * 1000)) * 10) / 10;
      const mergeHours = Math.round((msToFirstMerge / (60 * 60 * 1000)) * 10) / 10;

      return {
        id: "throwaway-account",
        weight: Math.round(severity * 10_000) / 10_000,
        detail:
          `Throwaway-account indicators: ${mergeCount} merge operation(s) within ` +
          `${mergeHours}h of creation/first-seen (account age ${ageHours}h)`,
      };
    },
  };
}

export default createThrowawayMergeRule;
