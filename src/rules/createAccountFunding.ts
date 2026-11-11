/**
 * Create-account funding-pattern detector rule (issue #30).
 *
 * Targets the Stellar abuse pattern where accounts are mass-funded via
 * `create_account`, especially many small accounts funded by the same
 * source within a short window (README.md:19). Consumes
 * create-account funding features (#30, lifecycle #23) and emits a
 * `create-account-funding` signal scaled by count and velocity.
 *
 * Thresholds are configurable so operators can tune sensitivity.
 */

import type { Signal } from "../types.js";
import type { Rule, RuleContext } from "./engine.js";
import { ValidationError } from "../errors.js";

/** Default rule weight (engine contribution) in [0, 1]. */
export const DEFAULT_CREATE_ACCOUNT_FUNDING_RULE_WEIGHT = 0.65;

/** Default minimum severity required to emit a signal. */
export const DEFAULT_CREATE_ACCOUNT_FUNDING_MIN_SCORE = 0.05;

/** Default number of funded accounts in the window/burst context that triggers. */
export const DEFAULT_CREATE_ACCOUNT_FUNDING_BURST_THRESHOLD = 5;

/** Default funded-account count treated as extreme mass funding. */
export const DEFAULT_CREATE_ACCOUNT_FUNDING_EXTREME_COUNT = 20;

export interface CreateAccountFundingRuleOptions {
  /**
   * Base rule weight (engine contribution) in [0, 1].
   * The emitted signal weight scales by severity.
   */
  readonly weight?: number;
  /** Minimum severity score required to emit a signal. Default: 0.05. */
  readonly minScore?: number;
  /** Funding ops in the burst window that count as a burst. Default: 5. */
  readonly burstThreshold?: number;
  /** Distinct funded accounts treated as extreme. Default: 20. */
  readonly extremeCount?: number;
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

function str(context: RuleContext, key: string): string | null {
  const value = context[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Creates the create-account funding rule.
 *
 * Reads features produced by `extractCreateAccountFundingFeatures` /
 * `createCreateAccountFundingFeatureProvider` (#30): outgoing funding
 * counts, windowed/velocity counts, burst detection, and funding source.
 * Emits `create-account-funding` scaled by count and velocity.
 */
export function createCreateAccountFundingRule(
  options: CreateAccountFundingRuleOptions = {}
): Rule {
  const weight = resolveNumber(
    options.weight,
    DEFAULT_CREATE_ACCOUNT_FUNDING_RULE_WEIGHT,
    "weight"
  );
  const minScore = resolveNumber(
    options.minScore,
    DEFAULT_CREATE_ACCOUNT_FUNDING_MIN_SCORE,
    "minScore"
  );
  const burstThreshold = resolvePositive(
    options.burstThreshold,
    DEFAULT_CREATE_ACCOUNT_FUNDING_BURST_THRESHOLD,
    "burstThreshold"
  );
  const extremeCount = resolvePositive(
    options.extremeCount,
    DEFAULT_CREATE_ACCOUNT_FUNDING_EXTREME_COUNT,
    "extremeCount"
  );

  return {
    id: "create-account-funding",
    weight,
    evaluate(context: RuleContext): Signal | null {
      const fundingCount = num(context, "createAccountFundingCount");
      const fundedAccounts = num(context, "createAccountFundedAccountsCount");
      const fundingSource = str(context, "createAccountFundingSource");
      const sourceCount = num(context, "createAccountFundingSourceCount");

      // Need either outgoing mass funding activity or visible incoming
      // funding-source attribution to emit a signal.
      if (fundingCount <= 0 && fundedAccounts <= 0 && !fundingSource) {
        return null;
      }

      const windowCount = num(context, "createAccountFundingCountInWindow");
      const windowFunded = num(context, "createAccountFundedAccountsInWindowCount");
      const burstCount = num(context, "createAccountFundingBurstCount");
      const burstDetected =
        bool(context, "createAccountFundingBurstDetected") ||
        burstCount >= burstThreshold;
      const extremeDetected =
        bool(context, "createAccountFundingExtremeCountDetected") ||
        fundedAccounts >= extremeCount;
      const score = num(context, "createAccountFundingScore");

      const countFactor = clamp01(fundedAccounts / extremeCount);
      const burstFactor = clamp01(burstCount / burstThreshold);
      const windowFactor = clamp01(windowCount / burstThreshold);
      const velocityFactor = clamp01(windowCount / Math.max(1, extremeCount));

      const severity = Math.max(
        score,
        clamp01(
          countFactor * 0.35 +
            burstFactor * 0.3 +
            windowFactor * 0.2 +
            velocityFactor * 0.15
        )
      );

      if (severity < minScore) {
        return null;
      }

      const reasons: string[] = [];
      if (fundingSource) {
        reasons.push(`funded by ${fundingSource}`);
        if (sourceCount > 1) {
          reasons.push(`${sourceCount} funding sources observed`);
        }
      }
      if (extremeDetected && fundedAccounts > 0) {
        reasons.push(
          `${fundedAccounts} accounts funded (extreme threshold ${extremeCount})`
        );
      } else if (fundedAccounts > 0) {
        reasons.push(`${fundedAccounts} accounts funded`);
      }
      if (burstDetected && burstCount > 0) {
        reasons.push(
          `${burstCount} create_account operations in a short burst (threshold ${burstThreshold})`
        );
      }
      if (windowCount > 0) {
        reasons.push(
          `${windowCount} recent funding ops (${windowFunded} distinct accounts in window)`
        );
      }
      if (reasons.length === 0 && fundingCount > 0) {
        reasons.push(`${fundingCount} create_account funding operations`);
      }
      if (reasons.length === 0) {
        return null;
      }

      return {
        id: "create-account-funding",
        weight: Math.round(Math.min(Math.max(severity, 0), 1) * 10_000) / 10_000,
        detail: `Create-account funding indicators: ${reasons.join(", ")}`,
      };
    },
  };
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

export default createCreateAccountFundingRule;
