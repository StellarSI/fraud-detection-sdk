/**
 * Asset feature extraction (issue #21).
 *
 * Asset holdings and trustline behavior (README.md:18, README.md:88) drive
 * several detectors — trustline abuse, asset spam ("dusting"), and issuer
 * concentration. This module derives balance/trustline signals from the
 * normalized account (#12) so feature code never sees raw Horizon JSON,
 * and counts `change_trust` events over a window from the normalized
 * transaction history (#13).
 *
 * Contract:
 * - Balances, trustline count, asset diversity, and issuer concentration
 *   are extracted from a {@link Account} (issue #12), never from raw JSON.
 * - Asset identifiers are canonicalized to `CODE:ISSUER` form; the native
 *   asset is reported as `XLM` (it has no issuer).
 * - Issuer concentration is measured over trustline count (balances in
 *   different assets cannot be summed), i.e. the fraction of an account's
 *   trustlines tied to its most-used issuer.
 * - Trustline churn (created vs. removed) over a window is derived from
 *   `change_trust` transactions in the history. Stellar removes a
 *   trustline with the same operation (limit 0), and the normalized
 *   transaction does not carry that limit, so created and removed cannot
 *   be told apart here; they are reported together as `trustlineChanges`.
 * - Missing or malformed entries are tolerated; the native balance is
 *   always well-formed because Horizon normalizes it.
 * - Empty histories yield zeroed trustline-churn features, never errors.
 */

import type { Account, AccountBalance, Transaction } from "../clients/horizon.js";
import { ValidationError } from "../errors.js";
import type {
  FeatureContext,
  FeatureMap,
  FeatureProvider,
} from "./types.js";

/** Default window for trustline churn: 7 days. */
export const DEFAULT_TRUSTLINE_CHURN_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** Well-known canonical identifier for the native asset. */
export const NATIVE_ASSET_ID = "XLM";

/** Fallback placeholder used when an asset code or issuer is missing. */
const UNKNOWN_ASSET_PART = "UNKNOWN";

/** Options for {@link extractAssetFeatures}. */
export interface AssetFeatureOptions {
  /** Transaction history for trustline churn (issue #13). */
  readonly transactions?: readonly Transaction[];
  /** Churn window in milliseconds; defaults to {@link DEFAULT_TRUSTLINE_CHURN_WINDOW_MS}. */
  readonly churnWindowMs?: number;
  /** Reference time for the churn window; defaults to `Date.now()`. */
  readonly now?: Date | string | number;
}

/** Asset and trustline features for one account. */
export interface AssetFeatures {
  /** Total balance entries on the account (native plus issued). */
  readonly balanceCount: number;
  /** Native (XLM) balance amount held. */
  readonly nativeBalance: number;
  /** Number of non-native (issued asset) balances. */
  readonly issuedBalanceCount: number;
  /** Trustline count: one per non-native balance. */
  readonly trustlineCount: number;
  /** Issued balances with a zero amount (dusted/unused trustlines). */
  readonly zeroBalanceTrustlineCount: number;
  /** Distinct canonical asset identifiers, including native (`XLM`). */
  readonly assetDiversity: number;
  /** Distinct issuers across issued balances. */
  readonly issuerDiversity: number;
  /** Fraction of trustlines tied to the most-used issuer, in (0, 1]; 0 when none. */
  readonly issuerConcentration: number;
  /** Issuer with the most trustlines (lexicographically first on ties); null when none. */
  readonly topIssuer: string | null;
  /** Issued balances the account is authorized to hold. */
  readonly authorizedTrustlineCount: number;
  /** Issued balances the account is not authorized to hold. */
  readonly unauthorizedTrustlineCount: number;
  /** Issued balances on clawback-enabled assets. */
  readonly clawbackEnabledCount: number;
  /** Sorted canonical asset identifiers (`CODE:ISSUER`, `XLM` for native). */
  readonly assetIds: readonly string[];
  /** `change_trust` transactions in the churn window (create + remove events). */
  readonly trustlineChanges: number;
  /** The churn window applied, in milliseconds. */
  readonly trustlineChurnMs: number;
  /** ISO-8601 reference time the churn window ends at. */
  readonly referenceTime: string;
}

/** Canonical `CODE:ISSUER` identifier for a balance (`XLM` for native). */
export function canonicalAssetId(balance: AccountBalance): string {
  if (!balance || typeof balance !== "object") {
    return `${UNKNOWN_ASSET_PART}:${UNKNOWN_ASSET_PART}`;
  }
  if (balance.type === "native") {
    return NATIVE_ASSET_ID;
  }
  const code =
    typeof balance.code === "string" && balance.code.trim().length > 0
      ? balance.code.trim().toUpperCase()
      : UNKNOWN_ASSET_PART;
  const issuer =
    typeof balance.issuer === "string" && balance.issuer.trim().length > 0
      ? balance.issuer.trim()
      : UNKNOWN_ASSET_PART;
  return `${code}:${issuer}`;
}

/** Sorts and de-duplicates canonical asset identifiers. */
function uniqueSorted(values: string[]): string[] {
  return Array.from(new Set(values)).sort();
}

function resolveChurnWindow(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_TRUSTLINE_CHURN_WINDOW_MS;
  }
  if (!Number.isFinite(value) || value <= 0) {
    throw new ValidationError("churnWindowMs must be a positive finite number");
  }
  return Math.trunc(value);
}

function resolveReferenceTime(now: AssetFeatureOptions["now"]): number {
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

function parseTimestamp(value: string): number | undefined {
  if (typeof value !== "string" || value.length === 0) {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Counts trustline-affecting (`change_trust`) transactions inside the window. */
function countChangeTrustInWindow(
  transactions: readonly Transaction[] | undefined,
  reference: number,
  churnWindowMs: number
): number {
  if (transactions === undefined) {
    return 0;
  }
  if (!Array.isArray(transactions)) {
    throw new ValidationError("transactions must be an array");
  }

  const start = reference - churnWindowMs;
  let count = 0;
  for (const transaction of transactions) {
    if (!transaction || typeof transaction !== "object") {
      continue;
    }
    if (
      typeof transaction.type !== "string" ||
      transaction.type.trim().toLowerCase() !== "change_trust"
    ) {
      continue;
    }
    const timestamp = parseTimestamp(transaction.createdAt);
    if (timestamp === undefined || timestamp > reference || timestamp < start) {
      continue;
    }
    count += 1;
  }
  return count;
}

/**
 * Computes asset and trustline features from a normalized account.
 *
 * @param account - Normalized account (issue #12).
 * @param options - Transaction history and window bounds for churn.
 * @returns Deterministic {@link AssetFeatures}.
 * @throws {ValidationError} If the account/history is missing or the options are invalid.
 */
export function extractAssetFeatures(
  account: Account,
  options: AssetFeatureOptions = {}
): AssetFeatures {
  if (!account || typeof account !== "object") {
    throw new ValidationError("account must be a normalized Account object");
  }

  const balances = Array.isArray(account.balances) ? account.balances : [];
  const churnWindowMs = resolveChurnWindow(options.churnWindowMs);
  const reference = resolveReferenceTime(options.now);

  let nativeBalance = 0;
  let issuedBalanceCount = 0;
  let zeroBalanceTrustlineCount = 0;
  let authorizedTrustlineCount = 0;
  let unauthorizedTrustlineCount = 0;
  let clawbackEnabledCount = 0;

  const assetIds: string[] = [];
  const issuerCounts = new Map<string, number>();

  for (const balance of balances) {
    if (!balance || typeof balance !== "object") {
      continue;
    }
    const canonical = canonicalAssetId(balance);
    assetIds.push(canonical);

    if (balance.type === "native") {
      const amount = typeof balance.amount === "number" ? balance.amount : Number(balance.amount);
      nativeBalance += Number.isFinite(amount) ? amount : 0;
      continue;
    }

    issuedBalanceCount += 1;

    const amount = typeof balance.amount === "number" ? balance.amount : Number(balance.amount);
    if (Number.isFinite(amount) && amount === 0) {
      zeroBalanceTrustlineCount += 1;
    }

    if (balance.authorized === false) {
      unauthorizedTrustlineCount += 1;
    } else {
      authorizedTrustlineCount += 1;
    }
    if (balance.clawbackEnabled === true) {
      clawbackEnabledCount += 1;
    }

    const issuerKey =
      typeof balance.issuer === "string" && balance.issuer.trim().length > 0
        ? balance.issuer.trim()
        : UNKNOWN_ASSET_PART;
    issuerCounts.set(issuerKey, (issuerCounts.get(issuerKey) ?? 0) + 1);
  }

  const sortedIds = uniqueSorted(assetIds);

  let topIssuer: string | null = null;
  let topIssuerCount = 0;
  for (const [issuer, count] of issuerCounts) {
    if (count > topIssuerCount || (count === topIssuerCount && topIssuer !== null && issuer < topIssuer)) {
      topIssuer = issuer;
      topIssuerCount = count;
    }
  }

  return {
    balanceCount: balances.length,
    nativeBalance,
    issuedBalanceCount,
    trustlineCount: issuedBalanceCount,
    zeroBalanceTrustlineCount,
    assetDiversity: sortedIds.length,
    issuerDiversity: issuerCounts.size,
    issuerConcentration:
      issuedBalanceCount > 0 ? topIssuerCount / issuedBalanceCount : 0,
    topIssuer,
    authorizedTrustlineCount,
    unauthorizedTrustlineCount,
    clawbackEnabledCount,
    assetIds: sortedIds,
    trustlineChanges: countChangeTrustInWindow(
      options.transactions,
      reference,
      churnWindowMs
    ),
    trustlineChurnMs: churnWindowMs,
    referenceTime: new Date(reference).toISOString(),
  };
}

/**
 * Flattens asset features into the registry's uniform map (#24).
 *
 * Structured values that are not scalar (the canonical id list) are kept
 * on {@link AssetFeatures} and omitted from the map.
 *
 * @param features - Output of {@link extractAssetFeatures}.
 * @returns Scalar feature values keyed for downstream consumers.
 */
export function assetFeaturesToFeatureMap(features: AssetFeatures): FeatureMap {
  return {
    assetBalanceCount: features.balanceCount,
    assetNativeBalance: features.nativeBalance,
    assetIssuedBalanceCount: features.issuedBalanceCount,
    assetTrustlineCount: features.trustlineCount,
    assetZeroBalanceTrustlineCount: features.zeroBalanceTrustlineCount,
    assetDiversity: features.assetDiversity,
    assetIssuerDiversity: features.issuerDiversity,
    assetIssuerConcentration: features.issuerConcentration,
    assetTopIssuer: features.topIssuer,
    assetAuthorizedTrustlineCount: features.authorizedTrustlineCount,
    assetUnauthorizedTrustlineCount: features.unauthorizedTrustlineCount,
    assetClawbackEnabledCount: features.clawbackEnabledCount,
    assetTrustlineChanges: features.trustlineChanges,
    assetTrustlineChurnMs: features.trustlineChurnMs,
  };
}

/**
 * Creates a registry-ready asset provider (#21, #24).
 *
 * The normalized account is read from `context.account` (set by the
 * registry from issue #12); history comes from `context.transactions` and
 * the churn window ends at `context.now` when supplied.
 *
 * @param options - Defaults; `context.now` and `context.transactions` win for churn.
 */
export function createAssetFeatureProvider(
  options: AssetFeatureOptions = {}
): FeatureProvider {
  return {
    name: "assets",
    compute(context: FeatureContext): FeatureMap {
      if (!context.account || typeof context.account !== "object") {
        throw new ValidationError(
          "Asset features require a normalized account in context.account (issue #12)"
        );
      }
      const features = extractAssetFeatures(context.account, {
        transactions: context.transactions,
        churnWindowMs: options.churnWindowMs,
        now: context.now ?? options.now,
      });
      return assetFeaturesToFeatureMap(features);
    },
  };
}
