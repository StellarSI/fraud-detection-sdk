/**
 * Trustline abuse and asset-spam detector rule (issue #27).
 *
 * Targets the Stellar abuse pattern where an account mass-creates
 * trustlines, spams assets, or dusts counterparties (README.md:18).
 * Consumes trustline-abuse features (#27, built on asset features #21)
 * and emits a `trustline-abuse` signal whose weight scales with severity.
 *
 * Thresholds are configurable so operators can tune sensitivity per
 * network/environment; the feature extractor accepts the same thresholds
 * so feature and rule stay aligned by default.
 */

import type { Signal } from "../types.js";
import type { Rule, RuleContext } from "./engine.js";
import { ValidationError } from "../errors.js";

/** Default rule weight (engine contribution) in [0, 1]. */
export const DEFAULT_TRUSTLINE_ABUSE_RULE_WEIGHT = 0.6;

/** Default minimum severity required to emit a signal. */
export const DEFAULT_TRUSTLINE_ABUSE_MIN_SCORE = 0.05;

/** Default trustline count treated as extreme. */
export const DEFAULT_TRUSTLINE_ABUSE_EXTREME_COUNT = 100;

/** Default `change_trust` count inside the burst window that is a burst. */
export const DEFAULT_TRUSTLINE_ABUSE_BURST_THRESHOLD = 10;

/** Default zero-balance trustline ratio that counts as dusting. */
export const DEFAULT_TRUSTLINE_ABUSE_DUST_RATIO = 0.5;

/** Default distinct-issuer count in the window that reads as asset spam. */
export const DEFAULT_TRUSTLINE_ABUSE_SPAM_ISSUERS = 10;

export interface TrustlineAbuseRuleOptions {
  /**
   * Base rule weight (engine contribution) in [0, 1].
   * The emitted signal weight scales by severity; the engine combines them.
   */
  readonly weight?: number;
  /** Minimum severity score required to emit a signal. Default: 0.05. */
  readonly minScore?: number;
  /** Trustline count treated as extreme. Default: 100. */
  readonly extremeTrustlineCount?: number;
  /** `change_trust` ops inside the burst window that count as a burst. Default: 10. */
  readonly burstThreshold?: number;
  /** Zero-balance trustline ratio that counts as dusting. Default: 0.5. */
  readonly dustRatioThreshold?: number;
  /** Distinct issuers in the window that count as asset spam. Default: 10. */
  readonly spamIssuerCount?: number;
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

function num(context: RuleContext, key: string): number {
  const value = context[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function bool(context: RuleContext, key: string): boolean {
  return context[key] === true;
}

/**
 * Creates the trustline-abuse rule.
 *
 * The rule reads features produced by `extractTrustlineAbuseFeatures` /
 * `createTrustlineAbuseFeatureProvider` (#27): `trustlineCount`,
 * `trustlineChurnCount`, `trustlineBurstCount`, `trustlineBurstDetected`,
 * `trustlineDistinctIssuersInWindow`, `trustlineDustCount`,
 * `trustlineDustRatio`, `trustlineExceedsExtremeCount`, and
 * `trustlineAbuseScore`.
 *
 * Severity (and thus signal weight) scales with trustline count, burst
 * size, churn, dust ratio, and issuer spread.
 */
export function createTrustlineAbuseRule(
  options: TrustlineAbuseRuleOptions = {}
): Rule {
  const weight = resolveNumber(
    options.weight,
    DEFAULT_TRUSTLINE_ABUSE_RULE_WEIGHT,
    "weight"
  );
  const minScore = resolveNumber(
    options.minScore,
    DEFAULT_TRUSTLINE_ABUSE_MIN_SCORE,
    "minScore"
  );
  const extremeTrustlineCount = resolvePositive(
    options.extremeTrustlineCount,
    DEFAULT_TRUSTLINE_ABUSE_EXTREME_COUNT,
    "extremeTrustlineCount"
  );
  const burstThreshold = resolvePositive(
    options.burstThreshold,
    DEFAULT_TRUSTLINE_ABUSE_BURST_THRESHOLD,
    "burstThreshold"
  );
  const dustRatioThreshold = resolvePositive(
    options.dustRatioThreshold,
    DEFAULT_TRUSTLINE_ABUSE_DUST_RATIO,
    "dustRatioThreshold"
  );
  const spamIssuerCount = resolvePositive(
    options.spamIssuerCount,
    DEFAULT_TRUSTLINE_ABUSE_SPAM_ISSUERS,
    "spamIssuerCount"
  );

  return {
    id: "trustline-abuse",
    weight,
    evaluate(context: RuleContext): Signal | null {
      const count = num(context, "trustlineCount");
      const churn = num(context, "trustlineChurnCount");
      const burst = num(context, "trustlineBurstCount");
      if (count <= 0 && churn <= 0 && burst <= 0) {
        return null;
      }

      const dustCount = num(context, "trustlineDustCount");
      const dustRatio = num(context, "trustlineDustRatio");
      const distinctIssuers = num(context, "trustlineDistinctIssuersInWindow");
      const score = num(context, "trustlineAbuseScore");
      const burstDetected =
        bool(context, "trustlineBurstDetected") || burst >= burstThreshold;
      const extremeDetected =
        bool(context, "trustlineExceedsExtremeCount") ||
        count >= extremeTrustlineCount;

      const countFactor =
        count > 0 ? Math.min(count / extremeTrustlineCount, 1) : 0;
      const burstFactor = Math.min(burst / burstThreshold, 1);
      const churnFactor = Math.min(churn / (burstThreshold * 4), 1);
      const effectiveDustRatio =
        dustRatio > 0
          ? dustRatio
          : count > 0
            ? dustCount / count
            : 0;
      const dustFactor =
        effectiveDustRatio > 0
          ? Math.min(effectiveDustRatio / dustRatioThreshold, 1)
          : 0;
      const spamFactor = Math.min(distinctIssuers / spamIssuerCount, 1);

      const severity = Math.max(
        score,
        Math.min(
          countFactor * 0.3 +
            burstFactor * 0.35 +
            churnFactor * 0.15 +
            dustFactor * 0.1 +
            spamFactor * 0.1,
          1
        )
      );

      if (severity < minScore) {
        return null;
      }

      const reasons: string[] = [];
      if (extremeDetected) {
        reasons.push(
          `${count} trustlines (extreme threshold ${extremeTrustlineCount})`
        );
      }
      if (burstDetected) {
        reasons.push(
          `${burst} trustline changes within the burst window (threshold ${burstThreshold})`
        );
      }
      if (effectiveDustRatio >= dustRatioThreshold && dustCount > 0) {
        reasons.push(`${dustCount} zero-balance/dusted trustlines`);
      }
      if (distinctIssuers >= spamIssuerCount) {
        reasons.push(`${distinctIssuers} distinct issuers in the window`);
      }
      if (reasons.length === 0) {
        reasons.push(`${churn} trustline changes and ${count} trustlines`);
      }

      return {
        id: "trustline-abuse",
        weight: Math.round(Math.min(Math.max(severity, 0), 1) * 10_000) / 10_000,
        detail: `Trustline abuse indicators: ${reasons.join(", ")}`,
      };
    },
  };
}

export default createTrustlineAbuseRule;
