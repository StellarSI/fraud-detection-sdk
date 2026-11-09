/**
 * Dusting detector rule (issue #28).
 *
 * Targets outbound payments of tiny amounts to many distinct
 * counterparties (README.md). Consumes dusting features (#28) and emits
 * a `dusting` signal scaled by recipient count and amount.
 *
 * Thresholds are configurable, and legitimate bulk micro-disbursements
 * (e.g. NGO payouts) can be distinguished using asset and volume context
 * so organized single-asset distributions are not mislabeled as spam.
 */

import type { Signal } from "../types.js";
import type { Rule, RuleContext } from "./engine.js";
import { ValidationError } from "../errors.js";

/** Default rule weight (engine contribution) in [0, 1]. */
export const DEFAULT_DUSTING_RULE_WEIGHT = 0.6;

/** Default minimum distinct recipients that indicate a dusting pattern. */
export const DEFAULT_DUSTING_RECIPIENT_THRESHOLD = 5;

/** Default minimum dust payments required. */
export const DEFAULT_DUSTING_PAYMENT_THRESHOLD = 5;

/** Default minimum severity required to emit a signal. */
export const DEFAULT_DUSTING_MIN_SCORE = 0.05;

/**
 * Default average amount (>=) above which a single-asset bulk distribution
 * may be treated as a legitimate micro-disbursement. Set to 0 to disable
 * this heuristic.
 */
export const DEFAULT_LEGITIMATE_MIN_AVERAGE_AMOUNT = 0.001;

/**
 * Default total volume (>=) above which a single-asset bulk distribution
 * may be treated as a legitimate micro-disbursement. Set to Infinity to
 * disable this heuristic.
 */
export const DEFAULT_LEGITIMATE_MIN_TOTAL_VOLUME = Number.POSITIVE_INFINITY;

/** Default maximum asset diversity for the legitimate-disbursement heuristic. */
export const DEFAULT_LEGITIMATE_MAX_ASSET_DIVERSITY = 1;

export interface DustingRuleOptions {
  /**
   * Base rule weight (engine contribution) in [0, 1].
   * The emitted signal weight scales by severity; the engine combines them.
   */
  readonly weight?: number;
  /** Minimum distinct recipients required to emit a signal. Default: 5. */
  readonly recipientCountThreshold?: number;
  /** Minimum dust payments required to emit a signal. Default: 5. */
  readonly paymentCountThreshold?: number;
  /**
   * Dust amount threshold for reference/configurability. Dusting features
   * are computed with their own dust threshold; this value is surfaced for
   * API completeness and detail text.
   */
  readonly dustThreshold?: number;
  /** Minimum severity score required to emit a signal. Default: 0.05. */
  readonly minScore?: number;
  /**
   * Maximum asset diversity for a distribution to be considered a
   * potential legitimate bulk micro-disbursement. Default: 1.
   */
  readonly legitimateMaxAssetDiversity?: number;
  /**
   * Average dust amount at/above which a low-diversity bulk distribution
   * is treated as a legitimate micro-disbursement (asset/volume context).
   * Default: 0.001. Set to 0 to disable.
   */
  readonly legitimateMinAverageAmount?: number;
  /**
   * Total dust volume at/above which a low-diversity bulk distribution is
   * treated as a legitimate micro-disbursement. Default: Infinity (disabled).
   */
  readonly legitimateMinTotalVolume?: number;
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

function resolveNonNegative(
  value: number | undefined,
  fallback: number,
  label: string
): number {
  const resolved = resolveNumber(value, fallback, label);
  if (resolved < 0) {
    throw new ValidationError(`${label} must be a non-negative finite number`);
  }
  return resolved;
}

function resolveVolumeThreshold(
  value: number | undefined,
  fallback: number,
  label: string
): number {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "number" || Number.isNaN(value) || value < 0) {
    throw new ValidationError(
      `${label} must be a non-negative number or Infinity`
    );
  }
  return value;
}

function num(context: RuleContext, key: string): number {
  const value = context[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Creates the dusting rule.
 *
 * Reads features produced by `extractDustingFeatures` /
 * `createDustingFeatureProvider` (#28): `dustPaymentCount`,
 * `dustRecipientCount`, `dustTotalVolume`, `dustAverageAmount`,
 * `dustAssetDiversity`, and `dustingScore`.
 *
 * Signal weight scales with recipient count and (inverse) amount context:
 * more recipients with smaller average amounts produce a stronger signal.
 */
export function createDustingRule(options: DustingRuleOptions = {}): Rule {
  const weight = resolveNumber(options.weight, DEFAULT_DUSTING_RULE_WEIGHT, "weight");
  const recipientCountThreshold = Math.max(
    1,
    Math.floor(
      resolveNumber(
        options.recipientCountThreshold,
        DEFAULT_DUSTING_RECIPIENT_THRESHOLD,
        "recipientCountThreshold"
      )
    )
  );
  const paymentCountThreshold = Math.max(
    1,
    Math.floor(
      resolveNumber(
        options.paymentCountThreshold,
        DEFAULT_DUSTING_PAYMENT_THRESHOLD,
        "paymentCountThreshold"
      )
    )
  );
  const configuredDustThreshold = resolveNonNegative(
    options.dustThreshold,
    0,
    "dustThreshold"
  );
  const minScore = resolveNumber(options.minScore, DEFAULT_DUSTING_MIN_SCORE, "minScore");
  const legitimateMaxAssetDiversity = Math.max(
    0,
    Math.floor(
      resolveNumber(
        options.legitimateMaxAssetDiversity,
        DEFAULT_LEGITIMATE_MAX_ASSET_DIVERSITY,
        "legitimateMaxAssetDiversity"
      )
    )
  );
  const legitimateMinAverageAmount = resolveNonNegative(
    options.legitimateMinAverageAmount,
    DEFAULT_LEGITIMATE_MIN_AVERAGE_AMOUNT,
    "legitimateMinAverageAmount"
  );
  const legitimateMinTotalVolume = resolveVolumeThreshold(
    options.legitimateMinTotalVolume,
    DEFAULT_LEGITIMATE_MIN_TOTAL_VOLUME,
    "legitimateMinTotalVolume"
  );

  return {
    id: "dusting",
    weight,
    evaluate(context: RuleContext): Signal | null {
      const dustPaymentCount = num(context, "dustPaymentCount");
      const dustRecipientCount = num(context, "dustRecipientCount");
      if (
        dustPaymentCount < paymentCountThreshold ||
        dustRecipientCount < recipientCountThreshold
      ) {
        return null;
      }

      const dustTotalVolume = num(context, "dustTotalVolume");
      const dustAverageAmount = num(context, "dustAverageAmount");
      const dustAssetDiversity = num(context, "dustAssetDiversity");
      const featureDustThreshold = num(context, "dustThreshold");
      const baseScore = num(context, "dustingScore");

      // Asset and volume context: distinguish legitimate bulk
      // micro-disbursements (e.g. organized single-asset payouts) from
      // spam/deanonymization dusting.
      const lowAssetDiversity =
        dustAssetDiversity <= legitimateMaxAssetDiversity;
      const meaningfulAverage =
        legitimateMinAverageAmount > 0 &&
        dustAverageAmount >= legitimateMinAverageAmount;
      const meaningfulVolume = dustTotalVolume >= legitimateMinTotalVolume;
      if (lowAssetDiversity && (meaningfulAverage || meaningfulVolume)) {
        return null;
      }

      const recipientFactor = Math.min(
        dustRecipientCount / Math.max(recipientCountThreshold, 1),
        3
      ) / 3;
      const paymentFactor = Math.min(
        dustPaymentCount / Math.max(paymentCountThreshold, 1),
        3
      ) / 3;
      const referenceThreshold =
        configuredDustThreshold > 0
          ? configuredDustThreshold
          : featureDustThreshold > 0
            ? featureDustThreshold
            : 1;
      const smallAmountFactor =
        referenceThreshold > 0
          ? Math.max(0, 1 - Math.min(dustAverageAmount / referenceThreshold, 1))
          : 0;
      const severity = Math.max(
        baseScore,
        Math.min(
          recipientFactor * 0.5 + paymentFactor * 0.25 + smallAmountFactor * 0.25,
          1
        )
      );

      if (severity < minScore) {
        return null;
      }

      const thresholdText =
        featureDustThreshold > 0
          ? ` <= ${featureDustThreshold}`
          : configuredDustThreshold > 0
            ? ` <= ${configuredDustThreshold}`
            : "";

      return {
        id: "dusting",
        weight: Math.round(Math.min(Math.max(severity, 0), 1) * 10_000) / 10_000,
        detail:
          `Dusting indicators: ${dustPaymentCount} outbound payment(s)${thresholdText} to ` +
          `${dustRecipientCount} distinct recipient(s), total volume ${dustTotalVolume}, ` +
          `avg ${dustAverageAmount} across ${dustAssetDiversity} asset(s)`,
      };
    },
  };
}

export default createDustingRule;
