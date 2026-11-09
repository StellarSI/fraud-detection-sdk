/**
 * Trustline abuse and asset-spam feature extraction (issue #27).
 *
 * "Trustline abuse: mass trustline creation, asset spam, and 'dusting' of
 * accounts" (README.md:18) is a named Stellar abuse pattern. This module
 * derives the signals the trustline-abuse rule needs from data the SDK
 * already normalizes:
 *
 * - **Trustline count and churn** come from the asset features (#21):
 *   `trustlineCount`, `trustlineChanges` over a window, zero-balance
 *   trustlines ("dust"), asset diversity, and issuer concentration.
 * - **Bursts** are measured directly from `change_trust` transactions in
 *   the history (#13) with a sliding window, so a rapid creation spree is
 *   visible even when the account's current balances look small.
 * - **Asset spam** is measured as the number of distinct issuers/assets
 *   touched by `change_trust` operations inside the churn window.
 *
 * Contract:
 * - The normalized account (#12) is required (trustline counts are an
 *   account property); a missing account is a `ValidationError`.
 * - Stellar removes a trustline with the same `change_trust` operation
 *   (limit 0), and the normalized transaction does not carry the limit, so
 *   creation and removal cannot be told apart. Both are counted as churn,
 *   matching the asset features (#21) contract.
 * - Empty histories yield zeroed burst/churn features, never errors.
 * - Thresholds are configurable; identical input yields identical output.
 */

import type { Account, Transaction } from "../clients/horizon.js";
import { ValidationError } from "../errors.js";
import {
  DEFAULT_TRUSTLINE_CHURN_WINDOW_MS,
  extractAssetFeatures,
} from "./assets.js";
import type {
  FeatureContext,
  FeatureMap,
  FeatureProvider,
} from "./types.js";

/** Default window for a "burst" of trustline changes: 1 hour. */
export const DEFAULT_TRUSTLINE_BURST_WINDOW_MS = 60 * 60 * 1000;

/** Default trustline count at or above which an account is "extreme". */
export const DEFAULT_EXTREME_TRUSTLINE_COUNT = 100;

/** Default number of `change_trust` ops inside the burst window that is a burst. */
export const DEFAULT_TRUSTLINE_BURST_THRESHOLD = 10;

/** Default fraction of zero-balance trustlines that indicates dusting. */
export const DEFAULT_TRUSTLINE_DUST_RATIO_THRESHOLD = 0.5;

/** Number of distinct issuers in the window that reads as asset spam. */
export const DEFAULT_TRUSTLINE_SPAM_ISSUER_COUNT = 10;

/** Options for {@link extractTrustlineAbuseFeatures}. */
export interface TrustlineAbuseOptions {
  /** Transaction history for churn/burst detection (issue #13). */
  readonly transactions?: readonly Transaction[];
  /** Reference time for the churn/burst windows. Defaults to now. */
  readonly now?: Date | string | number;
  /** Trustline churn window. Default: 7 days (asset features default). */
  readonly churnWindowMs?: number;
  /** Burst window for rapid trustline changes. Default: 1 hour. */
  readonly burstWindowMs?: number;
  /** Trustline count treated as extreme. Default: 100. */
  readonly extremeTrustlineCount?: number;
  /** `change_trust` ops inside the burst window that count as a burst. Default: 10. */
  readonly burstThreshold?: number;
  /** Zero-balance trustline ratio that counts as dusting. Default: 0.5. */
  readonly dustRatioThreshold?: number;
  /** Distinct issuers in the window that count as asset spam. Default: 10. */
  readonly spamIssuerCount?: number;
}

/** Per-account trustline-abuse features. */
export interface TrustlineAbuseFeatures {
  /** Total issued-asset trustlines on the account (#21). */
  readonly trustlineCount: number;
  /** Distinct canonical assets on the account (#21). */
  readonly assetDiversity: number;
  /** Fraction of trustlines tied to the top issuer (#21), in [0, 1]. */
  readonly issuerConcentration: number;
  /** `change_trust` operations inside the churn window (#21). */
  readonly churnCount: number;
  /** Maximum `change_trust` operations inside any burst window. */
  readonly burstCount: number;
  /** True when {@link burstCount} reaches the configured burst threshold. */
  readonly burstDetected: boolean;
  /** Distinct assets touched by `change_trust` ops inside the churn window. */
  readonly distinctAssetsInWindow: number;
  /** Distinct issuers touched by `change_trust` ops inside the churn window. */
  readonly distinctIssuersInWindow: number;
  /** Zero-balance trustlines, i.e. dusted/unused trustlines (#21). */
  readonly dustCount: number;
  /** Dusted trustlines divided by total trustlines, in [0, 1]. */
  readonly dustRatio: number;
  /** True when the trustline count reaches the configured extreme threshold. */
  readonly extremeCountDetected: boolean;
  /** Combined severity in [0, 1], scaled by count, burst, churn, dust, spam. */
  readonly abuseScore: number;
  /** The churn window applied, in milliseconds. */
  readonly churnWindowMs: number;
  /** The burst window applied, in milliseconds. */
  readonly burstWindowMs: number;
  /** ISO-8601 reference time the windows end at. */
  readonly referenceTime: string;
}

function resolveReferenceTime(now: TrustlineAbuseOptions["now"]): number {
  if (now === undefined) {
    return Date.now();
  }
  const parsed =
    now instanceof Date
      ? now.getTime()
      : typeof now === "number"
        ? now
        : Date.parse(now);
  if (!Number.isFinite(parsed) || !Number.isFinite(new Date(parsed).getTime())) {
    throw new ValidationError(
      "now must be a valid Date, millisecond timestamp, or ISO-8601 string"
    );
  }
  return parsed;
}

function resolvePositive(
  value: number | undefined,
  fallback: number,
  label: string
): number {
  const candidate = value ?? fallback;
  if (typeof candidate !== "number" || !Number.isFinite(candidate) || candidate <= 0) {
    throw new ValidationError(`${label} must be a positive finite number`);
  }
  return candidate;
}

function resolveDustRatio(value: number | undefined): number {
  const candidate = value ?? DEFAULT_TRUSTLINE_DUST_RATIO_THRESHOLD;
  if (
    typeof candidate !== "number" ||
    !Number.isFinite(candidate) ||
    candidate <= 0 ||
    candidate > 1
  ) {
    throw new ValidationError(
      "dustRatioThreshold must be a finite number in (0, 1]"
    );
  }
  return candidate;
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

/** Normalizes Horizon's operation type spellings for comparison. */
function operationType(
  transaction: Transaction & { operationType?: string; operation_type?: string }
): string {
  const candidates = [
    transaction.type,
    transaction.operationType,
    transaction.operation_type,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim().toLowerCase().replace(/[\s-]+/g, "_");
    }
  }
  return "";
}

/**
 * Returns true when the transaction represents a `change_trust` operation.
 * Accepts `type` and duck-typed `operationType`/`operation_type`.
 */
export function isChangeTrustTransaction(
  transaction: Transaction & { operationType?: string; operation_type?: string }
): boolean {
  return operationType(transaction) === "change_trust";
}

function parseTimestamp(value: string): number | undefined {
  if (typeof value !== "string" || value.length === 0) {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Canonical `CODE:ISSUER` id for a `change_trust` transaction, when known. */
function transactionAssetId(transaction: Transaction): string | undefined {
  if (
    typeof transaction.assetCode !== "string" ||
    transaction.assetCode.trim().length === 0
  ) {
    return undefined;
  }
  const code = transaction.assetCode.trim().toUpperCase();
  const issuer =
    typeof transaction.assetIssuer === "string" &&
    transaction.assetIssuer.trim().length > 0
      ? transaction.assetIssuer.trim()
      : "UNKNOWN";
  return `${code}:${issuer}`;
}

/** Maximum number of timestamps inside any sliding window of `windowMs`. */
function maxInSlidingWindow(timestamps: readonly number[], windowMs: number): number {
  if (timestamps.length === 0) {
    return 0;
  }
  let best = 0;
  let start = 0;
  for (let end = 0; end < timestamps.length; end += 1) {
    while (timestamps[end] - timestamps[start] > windowMs) {
      start += 1;
    }
    best = Math.max(best, end - start + 1);
  }
  return best;
}

/**
 * Computes trustline-abuse and asset-spam features for one account.
 *
 * @param account - Normalized account (issue #12).
 * @param options - Windows and configurable thresholds.
 * @returns Deterministic {@link TrustlineAbuseFeatures}.
 * @throws {ValidationError} If the account, history, or options are invalid.
 */
export function extractTrustlineAbuseFeatures(
  account: Account,
  options: TrustlineAbuseOptions = {}
): TrustlineAbuseFeatures {
  if (!account || typeof account !== "object") {
    throw new ValidationError("account must be a normalized Account object");
  }

  const reference = resolveReferenceTime(options.now);
  const churnWindowMs = resolvePositive(
    options.churnWindowMs,
    DEFAULT_TRUSTLINE_CHURN_WINDOW_MS,
    "churnWindowMs"
  );
  const burstWindowMs = resolvePositive(
    options.burstWindowMs,
    DEFAULT_TRUSTLINE_BURST_WINDOW_MS,
    "burstWindowMs"
  );
  const extremeTrustlineCount = resolvePositive(
    options.extremeTrustlineCount,
    DEFAULT_EXTREME_TRUSTLINE_COUNT,
    "extremeTrustlineCount"
  );
  const burstThreshold = resolvePositive(
    options.burstThreshold,
    DEFAULT_TRUSTLINE_BURST_THRESHOLD,
    "burstThreshold"
  );
  const dustRatioThreshold = resolveDustRatio(options.dustRatioThreshold);
  const spamIssuerCount = resolvePositive(
    options.spamIssuerCount,
    DEFAULT_TRUSTLINE_SPAM_ISSUER_COUNT,
    "spamIssuerCount"
  );

  // Trustline count, churn, dust, and concentration come from asset
  // features (#21); this module only adds burst/spam windowing.
  const assets = extractAssetFeatures(account, {
    transactions: options.transactions,
    churnWindowMs,
    now: reference,
  });

  const churnStart = reference - churnWindowMs;
  const timestamps: number[] = [];
  const assetIds = new Set<string>();
  const issuers = new Set<string>();

  for (const transaction of options.transactions ?? []) {
    if (!transaction || typeof transaction !== "object") {
      continue;
    }
    if (!isChangeTrustTransaction(transaction as Transaction)) {
      continue;
    }
    const timestamp = parseTimestamp(transaction.createdAt);
    if (
      timestamp === undefined ||
      timestamp > reference ||
      timestamp < churnStart
    ) {
      continue;
    }
    timestamps.push(timestamp);

    const assetId = transactionAssetId(transaction);
    if (assetId !== undefined) {
      assetIds.add(assetId);
    }
    if (
      typeof transaction.assetIssuer === "string" &&
      transaction.assetIssuer.trim().length > 0
    ) {
      issuers.add(transaction.assetIssuer.trim());
    }
  }

  timestamps.sort((a, b) => a - b);
  const burstCount = maxInSlidingWindow(timestamps, burstWindowMs);
  const dustCount = assets.zeroBalanceTrustlineCount;
  const trustlineCount = assets.trustlineCount;
  const dustRatio = trustlineCount > 0 ? dustCount / trustlineCount : 0;

  const countFactor = clamp01(trustlineCount / extremeTrustlineCount);
  const burstFactor = clamp01(burstCount / burstThreshold);
  const churnFactor = clamp01(assets.trustlineChanges / (burstThreshold * 4));
  const dustFactor =
    dustRatio > 0 ? clamp01(dustRatio / dustRatioThreshold) : 0;
  const spamFactor = clamp01(issuers.size / spamIssuerCount);

  const abuseScore = clamp01(
    countFactor * 0.3 +
      burstFactor * 0.35 +
      churnFactor * 0.15 +
      dustFactor * 0.1 +
      spamFactor * 0.1
  );

  return {
    trustlineCount,
    assetDiversity: assets.assetDiversity,
    issuerConcentration: assets.issuerConcentration,
    churnCount: assets.trustlineChanges,
    burstCount,
    burstDetected: burstCount >= burstThreshold,
    distinctAssetsInWindow: assetIds.size,
    distinctIssuersInWindow: issuers.size,
    dustCount,
    dustRatio,
    extremeCountDetected: trustlineCount >= extremeTrustlineCount,
    abuseScore,
    churnWindowMs,
    burstWindowMs,
    referenceTime: new Date(reference).toISOString(),
  };
}

/**
 * Flattens trustline-abuse features into the registry's uniform map (#24).
 *
 * @param features - Output of {@link extractTrustlineAbuseFeatures}.
 * @returns Scalar feature values keyed for downstream consumers.
 */
export function trustlineAbuseFeaturesToFeatureMap(
  features: TrustlineAbuseFeatures
): FeatureMap {
  return {
    trustlineCount: features.trustlineCount,
    trustlineAssetDiversity: features.assetDiversity,
    trustlineIssuerConcentration: features.issuerConcentration,
    trustlineChurnCount: features.churnCount,
    trustlineBurstCount: features.burstCount,
    trustlineBurstDetected: features.burstDetected,
    trustlineDistinctAssetsInWindow: features.distinctAssetsInWindow,
    trustlineDistinctIssuersInWindow: features.distinctIssuersInWindow,
    trustlineDustCount: features.dustCount,
    trustlineDustRatio: features.dustRatio,
    trustlineExceedsExtremeCount: features.extremeCountDetected,
    trustlineAbuseScore: features.abuseScore,
    trustlineChurnWindowMs: features.churnWindowMs,
    trustlineBurstWindowMs: features.burstWindowMs,
  };
}

/** Options for {@link createTrustlineAbuseFeatureProvider}. */
export interface TrustlineAbuseProviderOptions extends TrustlineAbuseOptions {}

/**
 * Creates a registry-ready trustline-abuse provider (#24, #27).
 *
 * The normalized account is read from `context.account` (set by the
 * registry from issue #12); history comes from `context.transactions` and
 * the windows end at `context.now` when supplied.
 */
export function createTrustlineAbuseFeatureProvider(
  options: TrustlineAbuseProviderOptions = {}
): FeatureProvider {
  return {
    name: "trustlineAbuse",
    compute(context: FeatureContext): FeatureMap {
      if (!context.account || typeof context.account !== "object") {
        throw new ValidationError(
          "Trustline abuse features require a normalized account in context.account (issue #12)"
        );
      }
      return trustlineAbuseFeaturesToFeatureMap(
        extractTrustlineAbuseFeatures(context.account, {
          ...options,
          transactions: context.transactions,
          now: context.now ?? options.now,
        })
      );
    },
  };
}
