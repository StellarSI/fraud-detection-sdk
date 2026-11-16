/**
 * Anchor deposit/withdrawal anomaly feature extraction (issue #34).
 *
 * Anchors are the critical off/on-ramps of the Stellar network: irregular
 * memo or amount patterns around anchor interactions are a key compliance
 * signal (README.md:21). This module derives the shared substrate for the
 * anchor-anomaly detector from the normalized transaction history (#13),
 * reusing memo hygiene primitives (#22) so anchor memos are sanitized and
 * compared exactly like any other memo.
 *
 * - **Anchor identification** — transactions involving known anchor
 *   assets or issuers, configured explicitly (`anchorAssets`,
 *   `anchorAssetCodes`, `anchorAssetIssuers`). Nothing is flagged as an
 *   anchor transaction unless it matches the configured identifiers, so
 *   no anchor activity is hallucinated on unrelated histories.
 * - **Direction** — when the scored account is known, anchor transactions
 *   are split into inbound (`to === accountId`) and outbound
 *   (`from === accountId` or submitted by the scored account). Deposits
 *   and withdrawals are the same primitives viewed from either side.
 * - **Amount distribution** — total, mean, min, max, population standard
 *   deviation, concentration (`max / total`), and the number of
 *   transactions whose amount deviates from the mean by more than
 *   `zScoreThreshold` standard deviations. Irregular amount distributions
 *   (one huge transfer among dust, or vice versa) surface here.
 * - **Memo patterns** — anchor transactions are expected to carry memos
 *   (deposit references). Missing memos, reused `id` memos, and memo
 *   coverage are reported so the rule can flag irregular memo patterns.
 *
 * Contract:
 * - Transactions without a parseable amount contribute 0 to the amount
 *   statistics; amounts are clamped to finite numbers.
 * - Empty or non-anchor histories yield zeroed features, never errors.
 * - Computation is deterministic: identical context, identical output.
 */

import type { Transaction } from "../clients/horizon.js";
import { ValidationError } from "../errors.js";
import { NATIVE_ASSET_ID } from "./assets.js";
import { sanitizeMemo, normalizeMemoType } from "./memo.js";
import type {
  FeatureContext,
  FeatureMap,
  FeatureProvider,
} from "./types.js";

/** Default z-score above which an anchor transaction amount is an outlier. */
export const DEFAULT_ANCHOR_OUTLIER_Z_SCORE = 2;

/** Options for {@link extractAnchorAnomalyFeatures}. */
export interface AnchorAnomalyOptions {
  /** Account being scored; used to split inbound/outbound direction. */
  readonly accountId?: string;
  /**
   * Anchor assets as canonical identifiers: `CODE:ISSUER`, a bare asset
   * code (matches any issuer), or `XLM` for the native asset.
   */
  readonly anchorAssets?: readonly string[];
  /** Anchor asset codes, matched case-insensitively regardless of issuer. */
  readonly anchorAssetCodes?: readonly string[];
  /** Anchor issuer addresses, matched exactly. */
  readonly anchorAssetIssuers?: readonly string[];
  /** Z-score above which an amount counts as an outlier. Default: 2. */
  readonly zScoreThreshold?: number;
}

/** Anchor deposit/withdrawal anomaly features for one account history. */
export interface AnchorAnomalyFeatures {
  /** Transactions matching the configured anchor identifiers. */
  readonly anchorTransactionCount: number;
  /** Anchor transactions paying into the scored account. */
  readonly anchorInboundCount: number;
  /** Anchor transactions paid from / submitted by the scored account. */
  readonly anchorOutboundCount: number;
  /** Distinct canonical assets seen across anchor transactions. */
  readonly anchorDistinctAssetCount: number;
  /** Summed amount across anchor transactions. */
  readonly anchorTotalVolume: number;
  /** Mean amount across anchor transactions; 0 when there are none. */
  readonly anchorAmountMean: number;
  /** Smallest anchor amount observed; 0 when there are none. */
  readonly anchorAmountMin: number;
  /** Largest anchor amount observed; 0 when there are none. */
  readonly anchorAmountMax: number;
  /** Population standard deviation of anchor amounts; 0 when none. */
  readonly anchorAmountStdDev: number;
  /** Largest amount as a fraction of total volume, in [0, 1]; 0 when empty. */
  readonly anchorAmountMaxShare: number;
  /** Anchor transactions whose amount deviates by more than the z-threshold. */
  readonly anchorAmountOutlierCount: number;
  /** Anchor transactions carrying a usable memo. */
  readonly anchorMemoCount: number;
  /** Anchor transactions without a usable memo. */
  readonly anchorMemoMissingCount: number;
  /** Anchor transactions carrying an `id` memo. */
  readonly anchorMemoIdCount: number;
  /** Distinct `<type>:<value>` memos across anchor transactions. */
  readonly anchorMemoDistinctCount: number;
  /** Distinct anchor memos reused at least twice. */
  readonly anchorMemoReusedCount: number;
  /** Highest reuse of any single memo across anchor transactions. */
  readonly anchorMemoMaxReuseCount: number;
  /** Fraction of anchor transactions carrying a memo, in [0, 1]; 0 when empty. */
  readonly anchorMemoShare: number;
}

function resolveStringList(
  value: readonly string[] | undefined,
  label: string
): readonly string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new ValidationError(`${label} must be an array of strings`);
  }
  const resolved: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      throw new ValidationError(`${label} entries must be non-empty strings`);
    }
    resolved.push(entry.trim());
  }
  return resolved;
}

function resolveZScore(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_ANCHOR_OUTLIER_Z_SCORE;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new ValidationError("zScoreThreshold must be a positive finite number");
  }
  return value;
}

/** Canonical `CODE:ISSUER` identifier for a transaction asset (`XLM` for native). */
export function canonicalTransactionAssetId(transaction: Transaction): string {
  if (!transaction || typeof transaction !== "object") {
    return "UNKNOWN:UNKNOWN";
  }
  const code =
    typeof transaction.assetCode === "string" && transaction.assetCode.trim().length > 0
      ? transaction.assetCode.trim().toUpperCase()
      : transaction.assetIssuer === undefined
        ? NATIVE_ASSET_ID
        : "UNKNOWN";
  if (code === NATIVE_ASSET_ID) {
    return NATIVE_ASSET_ID;
  }
  const issuer =
    typeof transaction.assetIssuer === "string" && transaction.assetIssuer.trim().length > 0
      ? transaction.assetIssuer.trim()
      : "UNKNOWN";
  return `${code}:${issuer}`;
}

interface AnchorMatcher {
  matches(transaction: Transaction): boolean;
}

function buildAnchorMatcher(options: AnchorAnomalyOptions): AnchorMatcher {
  const assetEntries = resolveStringList(options.anchorAssets, "anchorAssets");
  const codes = resolveStringList(options.anchorAssetCodes, "anchorAssetCodes").map(
    (entry) => entry.toUpperCase()
  );
  const issuers = resolveStringList(options.anchorAssetIssuers, "anchorAssetIssuers");

  const canonicalIds = new Set<string>();
  const bareCodes = new Set<string>();
  for (const entry of assetEntries) {
    const upper = entry.toUpperCase();
    if (upper === NATIVE_ASSET_ID) {
      canonicalIds.add(NATIVE_ASSET_ID);
      continue;
    }
    const separator = entry.indexOf(":");
    if (separator === -1) {
      bareCodes.add(upper);
      continue;
    }
    const code = entry.slice(0, separator).trim().toUpperCase();
    const issuer = entry.slice(separator + 1).trim();
    if (code.length === 0 || issuer.length === 0) {
      throw new ValidationError(
        `anchorAssets entry "${entry}" must be XLM, CODE, or CODE:ISSUER`
      );
    }
    canonicalIds.add(`${code}:${issuer}`);
  }

  const codeSet = new Set<string>([...bareCodes, ...codes]);
  const issuerSet = new Set<string>(issuers);

  return {
    matches(transaction: Transaction): boolean {
      if (!transaction || typeof transaction !== "object") {
        return false;
      }
      const canonical = canonicalTransactionAssetId(transaction);
      if (canonicalIds.has(canonical)) {
        return true;
      }
      const code =
        typeof transaction.assetCode === "string"
          ? transaction.assetCode.trim().toUpperCase()
          : canonical === NATIVE_ASSET_ID
            ? NATIVE_ASSET_ID
            : "";
      if (code.length > 0 && codeSet.has(code)) {
        return true;
      }
      const issuer =
        typeof transaction.assetIssuer === "string" ? transaction.assetIssuer.trim() : "";
      if (issuer.length > 0 && issuerSet.has(issuer)) {
        return true;
      }
      return false;
    },
  };
}

function finiteAmount(value: unknown): number {
  const amount = typeof value === "number" ? value : Number(value);
  return Number.isFinite(amount) ? amount : 0;
}

/**
 * Computes anchor deposit/withdrawal anomaly features from a normalized
 * transaction history.
 *
 * @param transactions - Normalized transactions (issue #13).
 * @param options - Anchor identification and outlier z-score.
 * @returns Deterministic {@link AnchorAnomalyFeatures}.
 * @throws {ValidationError} If `transactions` is not an array or options are invalid.
 */
export function extractAnchorAnomalyFeatures(
  transactions: readonly Transaction[],
  options: AnchorAnomalyOptions = {}
): AnchorAnomalyFeatures {
  if (!Array.isArray(transactions)) {
    throw new ValidationError("transactions must be an array");
  }
  const matcher = buildAnchorMatcher(options);
  const zScoreThreshold = resolveZScore(options.zScoreThreshold);
  const accountId =
    typeof options.accountId === "string" && options.accountId.trim().length > 0
      ? options.accountId.trim()
      : undefined;

  let anchorTransactionCount = 0;
  let anchorInboundCount = 0;
  let anchorOutboundCount = 0;
  let anchorTotalVolume = 0;
  let anchorAmountMin = Number.POSITIVE_INFINITY;
  let anchorAmountMax = 0;

  const assetIds = new Set<string>();
  const amounts: number[] = [];
  const memoKeyCounts = new Map<string, number>();
  let anchorMemoCount = 0;
  let anchorMemoIdCount = 0;

  for (const transaction of transactions) {
    if (!transaction || typeof transaction !== "object") {
      continue;
    }
    if (!matcher.matches(transaction)) {
      continue;
    }

    anchorTransactionCount += 1;
    assetIds.add(canonicalTransactionAssetId(transaction));

    if (accountId !== undefined) {
      const to = typeof transaction.to === "string" ? transaction.to : undefined;
      const from = typeof transaction.from === "string" ? transaction.from : undefined;
      const source =
        typeof transaction.sourceAccount === "string" ? transaction.sourceAccount : undefined;
      if (to === accountId) {
        anchorInboundCount += 1;
      } else if (from === accountId || source === accountId) {
        anchorOutboundCount += 1;
      }
    }

    const amount = finiteAmount(transaction.amount);
    amounts.push(amount);
    anchorTotalVolume += amount;
    if (amount < anchorAmountMin) {
      anchorAmountMin = amount;
    }
    if (amount > anchorAmountMax) {
      anchorAmountMax = amount;
    }

    // Memo hygiene mirrors the memo feature family (#22): sanitize before use.
    const memo = sanitizeMemo(transaction.memo);
    const type = normalizeMemoType(transaction.memoType, memo.length > 0);
    if (memo.length > 0 && type !== "none") {
      anchorMemoCount += 1;
      if (type === "id") {
        anchorMemoIdCount += 1;
      }
      const key = `${type}:${memo}`;
      memoKeyCounts.set(key, (memoKeyCounts.get(key) ?? 0) + 1);
    }
  }

  const anchorAmountMean =
    amounts.length > 0 ? anchorTotalVolume / amounts.length : 0;

  let variance = 0;
  for (const amount of amounts) {
    const delta = amount - anchorAmountMean;
    variance += delta * delta;
  }
  variance = amounts.length > 0 ? variance / amounts.length : 0;
  const anchorAmountStdDev = Math.sqrt(variance);

  let anchorAmountOutlierCount = 0;
  if (anchorAmountStdDev > 0) {
    for (const amount of amounts) {
      if (Math.abs(amount - anchorAmountMean) > zScoreThreshold * anchorAmountStdDev) {
        anchorAmountOutlierCount += 1;
      }
    }
  }

  const anchorAmountMaxShare =
    anchorTotalVolume > 0 ? anchorAmountMax / anchorTotalVolume : 0;

  let anchorMemoReusedCount = 0;
  let anchorMemoMaxReuseCount = 0;
  for (const count of memoKeyCounts.values()) {
    if (count >= 2) {
      anchorMemoReusedCount += 1;
      if (count > anchorMemoMaxReuseCount) {
        anchorMemoMaxReuseCount = count;
      }
    }
  }

  const anchorMemoMissingCount = anchorTransactionCount - anchorMemoCount;

  return {
    anchorTransactionCount,
    anchorInboundCount,
    anchorOutboundCount,
    anchorDistinctAssetCount: assetIds.size,
    anchorTotalVolume,
    anchorAmountMean,
    anchorAmountMin: amounts.length > 0 ? anchorAmountMin : 0,
    anchorAmountMax,
    anchorAmountStdDev,
    anchorAmountMaxShare,
    anchorAmountOutlierCount,
    anchorMemoCount,
    anchorMemoMissingCount,
    anchorMemoIdCount,
    anchorMemoDistinctCount: memoKeyCounts.size,
    anchorMemoReusedCount,
    anchorMemoMaxReuseCount,
    anchorMemoShare:
      anchorTransactionCount > 0
        ? anchorMemoCount / anchorTransactionCount
        : 0,
  };
}

/**
 * Flattens anchor anomaly features into the registry's uniform map (#24).
 *
 * @param features - Output of {@link extractAnchorAnomalyFeatures}.
 */
export function anchorAnomalyFeaturesToFeatureMap(
  features: AnchorAnomalyFeatures
): FeatureMap {
  return {
    anchorTransactionCount: features.anchorTransactionCount,
    anchorInboundCount: features.anchorInboundCount,
    anchorOutboundCount: features.anchorOutboundCount,
    anchorDistinctAssetCount: features.anchorDistinctAssetCount,
    anchorTotalVolume: features.anchorTotalVolume,
    anchorAmountMean: features.anchorAmountMean,
    anchorAmountMin: features.anchorAmountMin,
    anchorAmountMax: features.anchorAmountMax,
    anchorAmountStdDev: features.anchorAmountStdDev,
    anchorAmountMaxShare: features.anchorAmountMaxShare,
    anchorAmountOutlierCount: features.anchorAmountOutlierCount,
    anchorMemoCount: features.anchorMemoCount,
    anchorMemoMissingCount: features.anchorMemoMissingCount,
    anchorMemoIdCount: features.anchorMemoIdCount,
    anchorMemoDistinctCount: features.anchorMemoDistinctCount,
    anchorMemoReusedCount: features.anchorMemoReusedCount,
    anchorMemoMaxReuseCount: features.anchorMemoMaxReuseCount,
    anchorMemoShare: features.anchorMemoShare,
  };
}

/** Options for {@link createAnchorAnomalyFeatureProvider}. */
export interface AnchorAnomalyProviderOptions extends AnchorAnomalyOptions {}

/**
 * Creates a registry-ready anchor anomaly provider (#34, #24).
 *
 * The scored account is read from `context.accountId`; the anchor
 * identifiers and z-score come from `options`.
 */
export function createAnchorAnomalyFeatureProvider(
  options: AnchorAnomalyProviderOptions = {}
): FeatureProvider {
  return {
    name: "anchor-anomaly",
    compute(context: FeatureContext): FeatureMap {
      if (!context || typeof context !== "object" || !Array.isArray(context.transactions)) {
        throw new ValidationError(
          "Anchor anomaly features require FeatureContext.transactions (issue #13)"
        );
      }
      const features = extractAnchorAnomalyFeatures(context.transactions, {
        ...options,
        accountId: context.accountId ?? options.accountId,
      });
      return anchorAnomalyFeaturesToFeatureMap(features);
    },
  };
}
