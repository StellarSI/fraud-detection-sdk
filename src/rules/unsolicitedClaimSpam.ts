/**
 * Unsolicited claim-spam detector rule (issue #32).
 *
 * Targets unsolicited claim spam: `create_claimable_balance` operations
 * created in favor of many distinct, unrelated accounts (README.md:20).
 * Such spam is used to annoy, phish, or deanonymize recipients. Consumes
 * claimable-balance features (#31/#32) and emits an
 * `unsolicited-claim-spam` signal scaled by recipient count.
 *
 * Organized airdrops can be distinguished using asset/amount context:
 * a single asset offered at a uniform amount to low-diversity claimants
 * (optionally with an airdrop memo marker) is not flagged. Thresholds
 * are configurable so operators can tune sensitivity per environment.
 */

import type { Signal } from "../types.js";
import type { Rule, RuleContext } from "./engine.js";
import { ValidationError } from "../errors.js";

/** Default rule weight (engine contribution) in [0, 1]. */
export const DEFAULT_UNSOLICITED_CLAIM_SPAM_RULE_WEIGHT = 0.6;

/** Default minimum severity required to emit a signal. */
export const DEFAULT_UNSOLICITED_CLAIM_SPAM_MIN_SCORE = 0.05;

/** Default minimum distinct claimants that indicate claim spam. */
export const DEFAULT_UNSOLICITED_CLAIM_SPAM_RECIPIENT_THRESHOLD = 5;

/** Default ratio of unrelated claimants treated as significant. */
export const DEFAULT_UNSOLICITED_CLAIM_SPAM_UNRELATED_RATIO = 0.5;

/** Default maximum asset diversity for a creation to read as an airdrop. */
export const DEFAULT_UNSOLICITED_CLAIM_SPAM_AIRDROP_MAX_ASSET_DIVERSITY = 1;

export interface UnsolicitedClaimSpamRuleOptions {
  /**
   * Base rule weight (engine contribution) in [0, 1].
   * The emitted signal weight scales by severity; the engine combines them.
   */
  readonly weight?: number;
  /** Minimum severity score required to emit a signal. Default: 0.05. */
  readonly minScore?: number;
  /** Minimum distinct claimants required to emit a signal. Default: 5. */
  readonly recipientCountThreshold?: number;
  /** Ratio of unrelated claimants treated as significant. Default: 0.5. */
  readonly unrelatedRatioThreshold?: number;
  /**
   * Maximum asset diversity for the bulk creation to be treated as a
   * potential legitimate airdrop. Default: 1. Set to 0 to disable.
   */
  readonly airdropMaxAssetDiversity?: number;
  /**
   * Require a uniform (single) amount across created balances for the
   * airdrop heuristic to apply. Default: true.
   */
  readonly airdropRequireUniformAmount?: boolean;
  /**
   * Require an airdrop memo marker (e.g. "airdrop") for the airdrop
   * heuristic to apply. Default: false.
   */
  readonly airdropRequireMemoMarker?: boolean;
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
 * Creates the unsolicited claim-spam rule.
 *
 * Reads features produced by `extractClaimableBalanceFeatures` /
 * `createClaimableBalanceFeatureProvider` (#32):
 * `unsolicitedClaimSpamDistinctClaimants` (falling back to
 * `claimableBalanceClaimantsCount`), `unsolicitedClaimSpamUnrelatedClaimants`,
 * `unsolicitedClaimSpamUnrelatedRatio`, `unsolicitedClaimSpamScore`,
 * `claimableBalanceCreatedCount`, `claimableBalanceBurstCount`,
 * `claimableBalanceAssetDiversity`, `claimableBalanceTotalVolume`,
 * `claimableBalanceUniformAmount`, and `claimableBalanceAirdropMemo`.
 *
 * Signal weight scales with the distinct-claimant count and how many of
 * those claimants have no prior relationship with the creator.
 */
export function createUnsolicitedClaimSpamRule(
  options: UnsolicitedClaimSpamRuleOptions = {}
): Rule {
  const weight = resolveNumber(
    options.weight,
    DEFAULT_UNSOLICITED_CLAIM_SPAM_RULE_WEIGHT,
    "weight"
  );
  const minScore = resolveNumber(
    options.minScore,
    DEFAULT_UNSOLICITED_CLAIM_SPAM_MIN_SCORE,
    "minScore"
  );
  const recipientCountThreshold = Math.max(
    1,
    Math.floor(
      resolvePositive(
        options.recipientCountThreshold,
        DEFAULT_UNSOLICITED_CLAIM_SPAM_RECIPIENT_THRESHOLD,
        "recipientCountThreshold"
      )
    )
  );
  const unrelatedRatioThreshold = resolveRatio(
    options.unrelatedRatioThreshold,
    DEFAULT_UNSOLICITED_CLAIM_SPAM_UNRELATED_RATIO,
    "unrelatedRatioThreshold"
  );
  const airdropMaxAssetDiversity = Math.floor(
    resolveNonNegative(
      options.airdropMaxAssetDiversity,
      DEFAULT_UNSOLICITED_CLAIM_SPAM_AIRDROP_MAX_ASSET_DIVERSITY,
      "airdropMaxAssetDiversity"
    )
  );
  const airdropRequireUniformAmount = resolveBoolean(
    options.airdropRequireUniformAmount,
    true,
    "airdropRequireUniformAmount"
  );
  const airdropRequireMemoMarker = resolveBoolean(
    options.airdropRequireMemoMarker,
    false,
    "airdropRequireMemoMarker"
  );

  return {
    id: "unsolicited-claim-spam",
    weight,
    evaluate(context: RuleContext): Signal | null {
      const distinctClaimants =
        num(context, "unsolicitedClaimSpamDistinctClaimants") ||
        num(context, "claimableBalanceClaimantsCount");
      if (distinctClaimants < recipientCountThreshold) {
        return null;
      }

      const created = num(context, "claimableBalanceCreatedCount");
      const unrelated = num(context, "unsolicitedClaimSpamUnrelatedClaimants");
      const unrelatedRatio =
        num(context, "unsolicitedClaimSpamUnrelatedRatio") ||
        (distinctClaimants > 0
          ? clamp01(unrelated / distinctClaimants)
          : 0);
      const spamScore = num(context, "unsolicitedClaimSpamScore");
      const assetDiversity = num(context, "claimableBalanceAssetDiversity");
      const totalVolume = num(context, "claimableBalanceTotalVolume");
      const burst = num(context, "claimableBalanceBurstCount");
      const uniformAmount = bool(context, "claimableBalanceUniformAmount");
      const airdropMemo = bool(context, "claimableBalanceAirdropMemo");

      // Asset/amount/memo context: distinguish an organized airdrop from
      // spam. Low asset diversity at a uniform amount (optionally with an
      // airdrop memo marker) reads as a single distribution, not spam.
      if (airdropMaxAssetDiversity > 0) {
        const lowDiversity =
          assetDiversity > 0 && assetDiversity <= airdropMaxAssetDiversity;
        const uniformOk = !airdropRequireUniformAmount || uniformAmount;
        const memoOk = !airdropRequireMemoMarker || airdropMemo;
        if (lowDiversity && uniformOk && memoOk) {
          return null;
        }
      }

      const recipientFactor =
        Math.min(distinctClaimants / recipientCountThreshold, 3) / 3;
      const unrelatedFactor = clamp01(
        unrelatedRatio / Math.max(unrelatedRatioThreshold, 1e-9)
      );
      const burstFactor = clamp01(burst / 5);

      const severity = Math.max(
        spamScore,
        clamp01(
          recipientFactor * 0.5 + unrelatedFactor * 0.35 + burstFactor * 0.15
        )
      );

      if (severity < minScore) {
        return null;
      }

      const reasons: string[] = [];
      reasons.push(`${distinctClaimants} distinct claimants`);
      if (unrelated > 0) {
        reasons.push(
          `${unrelated} claimant(s) with no prior relationship in the history`
        );
      }
      if (created > 0) {
        reasons.push(`${created} created balances, total volume ${totalVolume}`);
      }
      if (assetDiversity > 1) {
        reasons.push(`${assetDiversity} distinct assets offered`);
      }
      if (burst > 0) {
        reasons.push(`${burst} creations in a short burst`);
      }

      return {
        id: "unsolicited-claim-spam",
        weight: Math.round(Math.min(Math.max(severity, 0), 1) * 10_000) / 10_000,
        detail: `Unsolicited claim spam indicators: ${reasons.join(", ")}`,
      };
    },
  };
}

export default createUnsolicitedClaimSpamRule;
