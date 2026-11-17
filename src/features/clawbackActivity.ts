/**
 * Clawback-enabled asset activity feature extraction (issue #36).
 *
 * Clawback is a powerful issuer capability: unusual activity around
 * clawback-enabled assets — especially `clawback` operations or a sudden
 * burst of value moving through them — is a compliance-relevant signal
 * explicitly named in the spec (README.md:24). This module derives the
 * shared substrate for the clawback-activity detector from the normalized
 * account (#12), its balances (#21) and the normalized transaction
 * history (#13).
 *
 * - **Clawback-enabled assets** — identified from the account's balances
 *   (`balance.clawbackEnabled`) and optionally from an explicit allow-list
 *   (`clawbackAssets`, as `CODE:ISSUER` or a bare `CODE`). Nothing is
 *   treated as clawback-enabled unless it is identified here, so ordinary
 *   assets never produce clawback signals.
 * - **Clawback operations** — transactions whose operation type is a
 *   clawback (`clawback`, `clawback_claimable_balance`), counted even when
 *   the asset is not present in the account's current balances.
 * - **Volume / frequency** — amount and counterparty statistics over a
 *   configurable recent window, plus the maximum number of clawback
 *   events in any sliding burst window, so both "unusual amount" and
 *   "unusual frequency" are observable by the rule (#25).
 *
 * Contract:
 * - Empty histories or accounts with no clawback-enabled assets yield
 *   zeroed features, never errors.
 * - Transactions without a parseable timestamp are counted in totals but
 *   excluded from the windows, matching the velocity family (#19).
 * - Computation is deterministic: identical context, identical output.
 */

import type { Account, Transaction } from "../clients/horizon.js";
import { ValidationError } from "../errors.js";
import { canonicalAssetId, NATIVE_ASSET_ID } from "./assets.js";
import { canonicalTransactionAssetId } from "./anchorAnomaly.js";
import type {
  FeatureContext,
  FeatureMap,
  FeatureProvider,
} from "./types.js";

/** Default window for recent clawback-enabled asset activity: 24 hours. */
export const DEFAULT_CLAWBACK_ACTIVITY_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Default sliding window for a clawback burst: 1 hour. */
export const DEFAULT_CLAWBACK_ACTIVITY_BURST_WINDOW_MS = 60 * 60 * 1000;

/** Default number of clawback events inside the burst window that is a burst. */
export const DEFAULT_CLAWBACK_ACTIVITY_BURST_THRESHOLD = 3;

/** Horizon operation types that represent a clawback. */
export const CLAWBACK_OPERATION_TYPES: readonly string[] = [
  "clawback",
  "clawback_claimable_balance",
] as const;

/** Options for {@link extractClawbackActivityFeatures}. */
export interface ClawbackActivityOptions {
  /** Account being scored; used for direction and balance-based identification. */
  readonly accountId?: string;
  /**
   * Explicit clawback-enabled assets as canonical `CODE:ISSUER` ids or bare
   * asset codes (match any issuer). Combined with the account's balances.
   */
  readonly clawbackAssets?: readonly string[];
  /** Recent activity window in milliseconds. Default: 24 hours. */
  readonly windowMs?: number;
  /** Sliding burst window in milliseconds. Default: 1 hour. */
  readonly burstWindowMs?: number;
  /** Clawback events in the burst window that count as a burst. Default: 3. */
  readonly burstThreshold?: number;
  /** Reference time for the windows; defaults to `Date.now()`. */
  readonly now?: Date | string | number;
}

/** Clawback-enabled asset activity features for one account. */
export interface ClawbackActivityFeatures {
  /** Distinct clawback-enabled assets identified from balances/config. */
  readonly clawbackEnabledAssetCount: number;
  /** Recent transactions involving a clawback-enabled asset. */
  readonly clawbackTransactionCount: number;
  /** Recent `clawback` operations observed. */
  readonly clawbackOperationCount: number;
  /** Maximum clawback events inside any sliding burst window. */
  readonly clawbackBurstCount: number;
  /** True when {@link clawbackBurstCount} reaches the burst threshold. */
  readonly clawbackBurstDetected: boolean;
  /** Distinct clawback-enabled assets seen in recent transactions. */
  readonly clawbackDistinctAssetCount: number;
  /** Summed amount across recent clawback-enabled asset transactions. */
  readonly clawbackTotalVolume: number;
  /** Largest single amount in a recent clawback transaction. */
  readonly clawbackMaxAmount: number;
  /** Mean amount across recent clawback transactions; 0 when none. */
  readonly clawbackMeanAmount: number;
  /** Recent clawback transactions paying into the scored account. */
  readonly clawbackInboundCount: number;
  /** Recent clawback transactions paid from the scored account. */
  readonly clawbackOutboundCount: number;
  /** The recent window applied, in milliseconds. */
  readonly clawbackWindowMs: number;
  /** The burst window applied, in milliseconds. */
  readonly clawbackBurstWindowMs: number;
  /** The burst threshold applied. */
  readonly clawbackBurstThreshold: number;
  /** Total transactions considered. */
  readonly clawbackTotalCount: number;
  /** ISO-8601 reference time the windows end at. */
  readonly clawbackReferenceTime: string;
}

/** True when a normalized transaction is a clawback operation. */
export function isClawbackOperation(transaction: Transaction): boolean {
  if (!transaction || typeof transaction !== "object") {
    return false;
  }
  const type =
    typeof transaction.type === "string" ? transaction.type.trim().toLowerCase() : "";
  return CLAWBACK_OPERATION_TYPES.includes(type);
}

function resolveReferenceTime(now: ClawbackActivityOptions["now"]): number {
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
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new ValidationError(`${label} must be a positive finite number`);
  }
  return value;
}

function resolveAccountId(accountId: string | undefined): string | undefined {
  if (accountId === undefined) {
    return undefined;
  }
  if (typeof accountId !== "string" || accountId.trim().length === 0) {
    throw new ValidationError("accountId must be a non-empty string when provided");
  }
  return accountId.trim();
}

function finiteAmount(value: unknown): number {
  const amount = typeof value === "number" ? value : Number(value);
  return Number.isFinite(amount) ? amount : 0;
}

function parseTimestamp(value: string): number | undefined {
  if (typeof value !== "string" || value.length === 0) {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

interface ClawbackAssetMatcher {
  /** Number of fully identified clawback-enabled assets. */
  readonly identifiedCount: number;
  matches(transaction: Transaction): boolean;
}

/**
 * Builds the set of clawback-enabled assets from the account's balances and
 * the explicit configuration. Native XLM has no issuer and cannot carry a
 * clawback flag, so it is never treated as clawback-enabled here.
 */
function buildClawbackAssetMatcher(
  account: Account,
  options: ClawbackActivityOptions
): ClawbackAssetMatcher {
  const canonicalIds = new Set<string>();
  const bareCodes = new Set<string>();

  const balances = Array.isArray(account.balances) ? account.balances : [];
  for (const balance of balances) {
    if (
      !balance ||
      typeof balance !== "object" ||
      balance.clawbackEnabled !== true ||
      typeof balance.issuer !== "string" ||
      balance.issuer.trim().length === 0
    ) {
      continue;
    }
    const id = canonicalAssetId(balance);
    if (id !== NATIVE_ASSET_ID && !id.startsWith("UNKNOWN")) {
      canonicalIds.add(id);
    }
  }

  if (options.clawbackAssets !== undefined) {
    if (!Array.isArray(options.clawbackAssets)) {
      throw new ValidationError("clawbackAssets must be an array of strings");
    }
    for (const entry of options.clawbackAssets) {
      if (typeof entry !== "string" || entry.trim().length === 0) {
        throw new ValidationError("clawbackAssets entries must be non-empty strings");
      }
      const trimmed = entry.trim();
      const upper = trimmed.toUpperCase();
      if (upper === NATIVE_ASSET_ID) {
        continue;
      }
      const separator = trimmed.indexOf(":");
      if (separator === -1) {
        bareCodes.add(upper);
        continue;
      }
      const code = trimmed.slice(0, separator).trim().toUpperCase();
      const issuer = trimmed.slice(separator + 1).trim();
      if (code.length === 0 || issuer.length === 0) {
        throw new ValidationError(
          `clawbackAssets entry "${entry}" must be CODE or CODE:ISSUER`
        );
      }
      canonicalIds.add(`${code}:${issuer}`);
    }
  }

  return {
    identifiedCount: canonicalIds.size,
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
          : "";
      return code.length > 0 && bareCodes.has(code);
    },
  };
}

/**
 * Computes clawback-enabled asset activity features.
 *
 * @param account - Normalized account (issue #12) with clawback flags.
 * @param transactions - Normalized transaction history (issue #13).
 * @param options - Asset identification and window configuration.
 * @returns Deterministic {@link ClawbackActivityFeatures}.
 * @throws {ValidationError} If inputs or options are invalid.
 */
export function extractClawbackActivityFeatures(
  account: Account,
  transactions: readonly Transaction[],
  options: ClawbackActivityOptions = {}
): ClawbackActivityFeatures {
  if (!account || typeof account !== "object") {
    throw new ValidationError("account must be a normalized Account object");
  }
  if (!Array.isArray(transactions)) {
    throw new ValidationError("transactions must be an array");
  }

  const matcher = buildClawbackAssetMatcher(account, options);
  const resolvedAccountId = resolveAccountId(options.accountId);
  const windowMs = resolvePositive(
    options.windowMs,
    DEFAULT_CLAWBACK_ACTIVITY_WINDOW_MS,
    "windowMs"
  );
  const burstWindowMs = resolvePositive(
    options.burstWindowMs,
    DEFAULT_CLAWBACK_ACTIVITY_BURST_WINDOW_MS,
    "burstWindowMs"
  );
  const burstThreshold = resolvePositive(
    options.burstThreshold,
    DEFAULT_CLAWBACK_ACTIVITY_BURST_THRESHOLD,
    "burstThreshold"
  );
  const reference = resolveReferenceTime(options.now);
  const start = reference - windowMs;

  let clawbackTransactionCount = 0;
  let clawbackOperationCount = 0;
  let clawbackTotalVolume = 0;
  let clawbackMaxAmount = 0;
  let clawbackInboundCount = 0;
  let clawbackOutboundCount = 0;

  const assetsSeen = new Set<string>();
  const eventTimes: number[] = [];

  for (const transaction of transactions) {
    if (!transaction || typeof transaction !== "object") {
      continue;
    }

    const assetMatch = matcher.matches(transaction);
    const operationMatch = isClawbackOperation(transaction);
    if (!assetMatch && !operationMatch) {
      continue;
    }

    const timestamp = parseTimestamp(transaction.createdAt);
    if (timestamp === undefined || timestamp > reference || timestamp < start) {
      continue;
    }

    eventTimes.push(timestamp);

    if (assetMatch) {
      clawbackTransactionCount += 1;
      assetsSeen.add(canonicalTransactionAssetId(transaction));
      const amount = finiteAmount(transaction.amount);
      clawbackTotalVolume += amount;
      if (amount > clawbackMaxAmount) {
        clawbackMaxAmount = amount;
      }

      if (resolvedAccountId !== undefined) {
        const to = typeof transaction.to === "string" ? transaction.to : undefined;
        const from = typeof transaction.from === "string" ? transaction.from : undefined;
        const source =
          typeof transaction.sourceAccount === "string"
            ? transaction.sourceAccount
            : undefined;
        if (to === resolvedAccountId) {
          clawbackInboundCount += 1;
        } else if (from === resolvedAccountId || source === resolvedAccountId) {
          clawbackOutboundCount += 1;
        }
      }
    }

    if (operationMatch) {
      clawbackOperationCount += 1;
    }
  }

  // Largest number of clawback events inside any sliding burst window.
  eventTimes.sort((a, b) => a - b);
  let clawbackBurstCount = 0;
  let windowStart = 0;
  for (let index = 0; index < eventTimes.length; index += 1) {
    while (eventTimes[index] - eventTimes[windowStart] > burstWindowMs) {
      windowStart += 1;
    }
    const inWindow = index - windowStart + 1;
    if (inWindow > clawbackBurstCount) {
      clawbackBurstCount = inWindow;
    }
  }

  return {
    clawbackEnabledAssetCount: matcher.identifiedCount,
    clawbackTransactionCount,
    clawbackOperationCount,
    clawbackBurstCount,
    clawbackBurstDetected: clawbackBurstCount >= burstThreshold,
    clawbackDistinctAssetCount: assetsSeen.size,
    clawbackTotalVolume,
    clawbackMaxAmount,
    clawbackMeanAmount:
      clawbackTransactionCount > 0
        ? clawbackTotalVolume / clawbackTransactionCount
        : 0,
    clawbackInboundCount,
    clawbackOutboundCount,
    clawbackWindowMs: windowMs,
    clawbackBurstWindowMs: burstWindowMs,
    clawbackBurstThreshold: burstThreshold,
    clawbackTotalCount: transactions.length,
    clawbackReferenceTime: new Date(reference).toISOString(),
  };
}

/** Flattens clawback activity features into the registry's uniform map (#24). */
export function clawbackActivityFeaturesToFeatureMap(
  features: ClawbackActivityFeatures
): FeatureMap {
  return {
    clawbackEnabledAssetCount: features.clawbackEnabledAssetCount,
    clawbackTransactionCount: features.clawbackTransactionCount,
    clawbackOperationCount: features.clawbackOperationCount,
    clawbackBurstCount: features.clawbackBurstCount,
    clawbackBurstDetected: features.clawbackBurstDetected,
    clawbackDistinctAssetCount: features.clawbackDistinctAssetCount,
    clawbackTotalVolume: features.clawbackTotalVolume,
    clawbackMaxAmount: features.clawbackMaxAmount,
    clawbackMeanAmount: features.clawbackMeanAmount,
    clawbackInboundCount: features.clawbackInboundCount,
    clawbackOutboundCount: features.clawbackOutboundCount,
    clawbackWindowMs: features.clawbackWindowMs,
    clawbackBurstWindowMs: features.clawbackBurstWindowMs,
    clawbackBurstThreshold: features.clawbackBurstThreshold,
    clawbackTotalCount: features.clawbackTotalCount,
  };
}

/** Provider options for {@link createClawbackActivityFeatureProvider}. */
export interface ClawbackActivityProviderOptions extends ClawbackActivityOptions {}

/**
 * Creates a registry-ready clawback activity provider (#36, #24).
 *
 * The normalized account is read from `context.account`; history comes from
 * `context.transactions` and the windows end at `context.now` when supplied.
 */
export function createClawbackActivityFeatureProvider(
  options: ClawbackActivityProviderOptions = {}
): FeatureProvider {
  return {
    name: "clawback-activity",
    compute(context: FeatureContext): FeatureMap {
      if (!context.account || typeof context.account !== "object") {
        throw new ValidationError(
          "Clawback activity features require a normalized account in context.account (issue #12)"
        );
      }
      if (!Array.isArray(context.transactions)) {
        throw new ValidationError(
          "Clawback activity features require FeatureContext.transactions (issue #13)"
        );
      }
      const features = extractClawbackActivityFeatures(
        context.account,
        context.transactions,
        {
          ...options,
          accountId: context.accountId ?? options.accountId,
          now: context.now ?? options.now,
        }
      );
      return clawbackActivityFeaturesToFeatureMap(features);
    },
  };
}

export default extractClawbackActivityFeatures;
