/**
 * Anchor deposit/withdrawal anomaly detector rule (issue #34).
 *
 * Anchors are the critical off/on-ramps of the Stellar network: irregular
 * memo or amount patterns around anchor interactions are a key compliance
 * signal (README.md:21). Consumes anchor anomaly features (#34) — derived
 * from asset and transaction features (#21, #13) — and emits an
 * `anchor-anomaly` signal with a descriptive detail.
 *
 * Anchor identification is configured on the feature extractor
 * (`extractAnchorAnomalyFeatures` / `createAnchorAnomalyFeatureProvider`)
 * and the anomaly thresholds are configured here, so both are tunable per
 * environment. Benign anchor activity — regular memos and a stable amount
 * distribution — emits nothing.
 */

import type { Signal } from "../types.js";
import type { Rule, RuleContext } from "./engine.js";
import { ValidationError } from "../errors.js";

/** Default rule weight (engine contribution) in [0, 1]. */
export const DEFAULT_ANCHOR_ANOMALY_RULE_WEIGHT = 0.6;

/** Default minimum severity required to emit a signal. */
export const DEFAULT_ANCHOR_ANOMALY_MIN_SCORE = 0.05;

/**
 * Default minimum anchor transactions required before this rule evaluates.
 * Below this, there is not enough evidence to call the activity anomalous.
 */
export const DEFAULT_ANCHOR_ANOMALY_MIN_TRANSACTIONS = 3;

/** Default ratio of memo-less anchor transactions treated as irregular. */
export const DEFAULT_ANCHOR_ANOMALY_MISSING_MEMO_RATIO = 0.5;

/** Default maximum reuse of a single memo across anchor transactions. */
export const DEFAULT_ANCHOR_ANOMALY_MEMO_REUSE_THRESHOLD = 3;

/** Default amount-concentration threshold (max amount / total volume). */
export const DEFAULT_ANCHOR_ANOMALY_CONCENTRATION_THRESHOLD = 0.8;

/** Default minimum number of amount outliers required to flag the distribution. */
export const DEFAULT_ANCHOR_ANOMALY_OUTLIER_THRESHOLD = 1;

export interface AnchorAnomalyRuleOptions {
  /**
   * Base rule weight (engine contribution) in [0, 1].
   * The emitted signal weight scales by severity; the engine combines them.
   */
  readonly weight?: number;
  /** Minimum severity score required to emit a signal. Default: 0.05. */
  readonly minScore?: number;
  /**
   * Minimum anchor transactions required before this rule evaluates.
   * Must be a positive integer. Default: 3.
   */
  readonly minAnchorTransactions?: number;
  /**
   * Ratio of memo-less anchor transactions treated as an irregular memo
   * pattern, in [0, 1]. Default: 0.5.
   */
  readonly missingMemoRatioThreshold?: number;
  /**
   * Maximum reuse of a single memo across anchor transactions before the
   * memo pattern reads as replayed. Must be a positive integer. Default: 3.
   */
  readonly memoReuseThreshold?: number;
  /**
   * Concentration (max amount / total volume) above which the amount
   * distribution reads as irregular, in (0, 1]. Default: 0.8.
   */
  readonly concentrationThreshold?: number;
  /**
   * Minimum number of amount outliers (beyond the extractor's z-score)
   * required to flag the amount distribution. Must be a positive integer.
   * Default: 1.
   */
  readonly outlierThreshold?: number;
  /** Set false to silence amount-distribution anomalies. Default: true. */
  readonly enableAmountAnomalies?: boolean;
  /** Set false to silence memo-pattern anomalies. Default: true. */
  readonly enableMemoAnomalies?: boolean;
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

function resolveRatio(
  value: number | undefined,
  fallback: number,
  label: string,
  { exclusiveMinimum = false }: { exclusiveMinimum?: boolean } = {}
): number {
  const resolved = resolveNumber(value, fallback, label);
  const tooLow = exclusiveMinimum ? resolved <= 0 : resolved < 0;
  if (tooLow || resolved > 1) {
    throw new ValidationError(
      exclusiveMinimum ? `${label} must be in (0, 1]` : `${label} must be in [0, 1]`
    );
  }
  return resolved;
}

function resolveBoolean(
  value: boolean | undefined,
  fallback: boolean,
  label: string
): boolean {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "boolean") {
    throw new ValidationError(`${label} must be a boolean`);
  }
  return value;
}

function num(context: RuleContext, key: string): number {
  const value = context[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
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
 * Creates the anchor deposit/withdrawal anomaly rule.
 *
 * Reads features produced by `extractAnchorAnomalyFeatures` /
 * `createAnchorAnomalyFeatureProvider` (#34): `anchorTransactionCount`,
 * `anchorInboundCount`, `anchorOutboundCount`, `anchorTotalVolume`,
 * `anchorAmountMean`, `anchorAmountStdDev`, `anchorAmountMax`,
 * `anchorAmountMaxShare`, `anchorAmountOutlierCount`, `anchorMemoCount`,
 * `anchorMemoMissingCount`, `anchorMemoMaxReuseCount`, and
 * `anchorMemoDistinctCount`.
 *
 * Severity scales with how far the amount distribution and memo patterns
 * deviate from a stable anchor baseline. Accounts with no anchor activity
 * (or only regular anchor activity) emit nothing.
 */
export function createAnchorAnomalyRule(
  options: AnchorAnomalyRuleOptions = {}
): Rule {
  const weight = resolveNumber(
    options.weight,
    DEFAULT_ANCHOR_ANOMALY_RULE_WEIGHT,
    "weight"
  );
  const minScore = resolveNumber(
    options.minScore,
    DEFAULT_ANCHOR_ANOMALY_MIN_SCORE,
    "minScore"
  );
  if (minScore < 0 || minScore > 1) {
    throw new ValidationError("minScore must be in [0, 1]");
  }
  const minAnchorTransactions = resolvePositiveInteger(
    options.minAnchorTransactions,
    DEFAULT_ANCHOR_ANOMALY_MIN_TRANSACTIONS,
    "minAnchorTransactions"
  );
  const missingMemoRatioThreshold = resolveRatio(
    options.missingMemoRatioThreshold,
    DEFAULT_ANCHOR_ANOMALY_MISSING_MEMO_RATIO,
    "missingMemoRatioThreshold"
  );
  const memoReuseThreshold = resolvePositiveInteger(
    options.memoReuseThreshold,
    DEFAULT_ANCHOR_ANOMALY_MEMO_REUSE_THRESHOLD,
    "memoReuseThreshold"
  );
  const concentrationThreshold = resolveRatio(
    options.concentrationThreshold,
    DEFAULT_ANCHOR_ANOMALY_CONCENTRATION_THRESHOLD,
    "concentrationThreshold",
    { exclusiveMinimum: true }
  );
  const outlierThreshold = resolvePositiveInteger(
    options.outlierThreshold,
    DEFAULT_ANCHOR_ANOMALY_OUTLIER_THRESHOLD,
    "outlierThreshold"
  );
  const enableAmountAnomalies = resolveBoolean(
    options.enableAmountAnomalies,
    true,
    "enableAmountAnomalies"
  );
  const enableMemoAnomalies = resolveBoolean(
    options.enableMemoAnomalies,
    true,
    "enableMemoAnomalies"
  );
  if (!enableAmountAnomalies && !enableMemoAnomalies) {
    throw new ValidationError(
      "at least one anomaly class must be enabled (enableAmountAnomalies or enableMemoAnomalies)"
    );
  }

  return {
    id: "anchor-anomaly",
    weight,
    evaluate(context: RuleContext): Signal | null {
      const count = num(context, "anchorTransactionCount");
      if (count < minAnchorTransactions) {
        return null;
      }

      const totalVolume = num(context, "anchorTotalVolume");
      const mean = num(context, "anchorAmountMean");
      const stdDev = num(context, "anchorAmountStdDev");
      const maxAmount = num(context, "anchorAmountMax");
      const maxShare = Math.min(Math.max(num(context, "anchorAmountMaxShare"), 0), 1);
      const outlierCount = num(context, "anchorAmountOutlierCount");
      const memoCount = num(context, "anchorMemoCount");
      const missingMemoCount = num(
        context,
        "anchorMemoMissingCount"
      );
      const maxMemoReuse = num(context, "anchorMemoMaxReuseCount");
      const memoDistinct = num(context, "anchorMemoDistinctCount");

      // Amount-distribution irregularity: outliers against the anchor
      // baseline, a high coefficient of variation, or one transfer
      // dominating the volume.
      const outlierTriggered = outlierCount >= outlierThreshold;
      const concentrationTriggered = maxShare >= concentrationThreshold;
      const coefficientOfVariation = mean > 0 ? stdDev / mean : 0;
      const amountTriggered = enableAmountAnomalies && (outlierTriggered || concentrationTriggered);

      const outlierFactor = clamp01(outlierCount / (outlierThreshold * 3));
      const cvFactor = clamp01(coefficientOfVariation / 2);
      const concentrationFactor = clamp01(maxShare / concentrationThreshold);
      const amountFactor = enableAmountAnomalies
        ? clamp01(outlierFactor * 0.6 + cvFactor * 0.25 + concentrationFactor * 0.15)
        : 0;

      // Memo-pattern irregularity: anchor deposits without memos
      // (reconciliation breaks) or a single memo replayed across deposits.
      const missingRatio = count > 0 ? missingMemoCount / count : 0;
      const missingTriggered = missingRatio >= missingMemoRatioThreshold;
      const reuseTriggered = maxMemoReuse >= memoReuseThreshold;
      const memoTriggered = enableMemoAnomalies && (missingTriggered || reuseTriggered);

      const missingFactor = clamp01(
        missingRatio / Math.max(missingMemoRatioThreshold, 1e-9)
      );
      const reuseFactor = clamp01(maxMemoReuse / (memoReuseThreshold * 2));
      const memoFactor = enableMemoAnomalies
        ? clamp01(Math.max(missingFactor, reuseFactor))
        : 0;

      if (!amountTriggered && !memoTriggered) {
        return null;
      }

      // More anchor activity corroborates the pattern without dominating it.
      const countFactor = clamp01(count / (minAnchorTransactions * 4));
      const severity = clamp01(
        amountFactor * 0.45 + memoFactor * 0.45 + countFactor * 0.1
      );

      if (severity < minScore) {
        return null;
      }

      const reasons: string[] = [`${count} anchor transaction(s)`];
      if (totalVolume > 0) {
        reasons.push(`total volume ${totalVolume}`);
      }
      if (enableAmountAnomalies) {
        if (outlierTriggered) {
          reasons.push(
            `${outlierCount} amount outlier(s) (max ${maxAmount} vs mean ${Math.round(mean * 100) / 100})`
          );
        }
        if (concentrationTriggered) {
          reasons.push(
            `one transaction holds ${Math.round(maxShare * 100)}% of anchor volume`
          );
        }
      }
      if (enableMemoAnomalies) {
        if (missingTriggered) {
          reasons.push(
            `memo missing on ${missingMemoCount}/${count} anchor transaction(s)`
          );
        }
        if (reuseTriggered) {
          reasons.push(
            `memo reused ${maxMemoReuse} time(s) across anchor deposits`
          );
        }
        if (memoCount > 0 && memoDistinct > 0 && !reuseTriggered && !missingTriggered) {
          reasons.push(`${memoDistinct} distinct memo(s) across anchor deposits`);
        }
      }

      return {
        id: "anchor-anomaly",
        weight: Math.round(Math.min(Math.max(severity, 0), 1) * 10_000) / 10_000,
        detail: `Anchor deposit/withdrawal anomaly indicators: ${reasons.join(", ")}`,
      };
    },
  };
}

export default createAnchorAnomalyRule;
