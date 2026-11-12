/**
 * Claimable-balance feature extraction (issues #31, #32).
 *
 * "Claimable balances are a documented abuse vector on Stellar. The
 * README names this as a pattern the SDK must catch" (README.md:20) —
 * both claimable-balance abuse (#31) and unsolicited claim spam (#32)
 * start from the same primitive: `create_claimable_balance` operations
 * and their claimants, usually followed (or not) by
 * `claim_claimable_balance` operations. This module derives the shared
 * signal substrate for both detectors from the normalized transaction
 * history (#13).
 *
 * - **Creation activity** — `create_claimable_balance` operations by the
 *   scored account: totals, distinct claimants, windowed and
 *   burst-windowed counts.
 * - **Unclaimed balances** — created balances with no observed claim in
 *   the history and older than `unclaimedAgeMs` are treated as unclaimed.
 *   Claims are matched by balance id when records carry one; ops
 *   without a balance id cannot be matched individually and are counted
 *   as observed claims only in aggregate.
 * - **Spam context** — distinct claimants and how many of them have no
 *   other relationship with the scored account anywhere in the history
 *   (unrelated claimants), used by the unsolicited claim-spam rule (#32).
 * - **Airdrop context** — single-asset, uniform-amount creation with an
 *   optional airdrop memo marker reads as an organized airdrop rather
 *   than spam; detectors use this context to stand down.
 *
 * Contract:
 * - The scored account is required for attribution.
 * - Transactions without a parseable timestamp still count toward totals
 *   but cannot contribute to window/burst/age math.
 * - Empty histories yield zeroed features, never errors.
 * - Computation is deterministic: identical context, identical output.
 */

import type { Transaction } from "../clients/horizon.js";
import { ValidationError } from "../errors.js";
import type {
  FeatureContext,
  FeatureMap,
  FeatureProvider,
} from "./types.js";

/** Default window for counting recent claimable-balance creation: 24 hours. */
export const DEFAULT_CLAIMABLE_BALANCE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Default sliding window for a creation burst: 1 hour. */
export const DEFAULT_CLAIMABLE_BALANCE_BURST_WINDOW_MS = 60 * 60 * 1000;

/** Default number of created balances inside the burst window that is a burst. */
export const DEFAULT_CLAIMABLE_BALANCE_BURST_THRESHOLD = 5;

/** Default created-balance count treated as extreme mass creation. */
export const DEFAULT_CLAIMABLE_BALANCE_EXTREME_COUNT = 20;

/** Default age after which a created balance with no observed claim counts as unclaimed: 7 days. */
export const DEFAULT_CLAIMABLE_BALANCE_UNCLAIMED_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Default distinct-claimant count used as the reference for spam severity. */
export const DEFAULT_CLAIMABLE_BALANCE_SPAM_RECIPIENT_THRESHOLD = 5;

/** Memo pattern that marks a created balance as part of an airdrop. */
export const CLAIMABLE_BALANCE_AIRDROP_MEMO_PATTERN = /airdrop/i;

/** Options for {@link extractClaimableBalanceFeatures}. */
export interface ClaimableBalanceOptions {
  /** Account being scored (required). */
  readonly accountId?: string;
  /** Reference time for windows; defaults to `Date.now()`. */
  readonly now?: Date | string | number;
  /** Window for recent creation activity. Default: 24 hours. */
  readonly windowMs?: number;
  /** Sliding burst window. Default: 1 hour. */
  readonly burstWindowMs?: number;
  /** Created balances in the burst window that count as a burst. Default: 5. */
  readonly burstThreshold?: number;
  /** Created-balance count treated as extreme mass creation. Default: 20. */
  readonly extremeCount?: number;
  /** Age after which an unclaimed balance counts as unclaimed. Default: 7 days. */
  readonly unclaimedAgeMs?: number;
  /** Distinct-claimant reference for spam severity. Default: 5. */
  readonly spamRecipientThreshold?: number;
}

/** Claimable-balance features for one account history. */
export interface ClaimableBalanceFeatures {
  /** `create_claimable_balance` operations performed by this account. */
  readonly createdCount: number;
  /** Distinct claimants across created balances (claimant objects and `to` fallback). */
  readonly claimantsCount: number;
  /** Distinct claimants inside the recent window. */
  readonly claimantsCountInWindow: number;
  /** Creation operations inside the recent window. */
  readonly createdCountInWindow: number;
  /** Maximum creation operations inside any sliding burst window. */
  readonly burstCount: number;
  /** True when {@link burstCount} reaches the burst threshold. */
  readonly burstDetected: boolean;
  /** True when the distinct-claimant count reaches the extreme threshold. */
  readonly extremeCountDetected: boolean;
  /** `claim_claimable_balance` operations observed in the history. */
  readonly claimObservedCount: number;
  /** Created balances older than `unclaimedAgeMs` with no observed claim. */
  readonly unclaimedCount: number;
  /** {@link unclaimedCount} / max(1, {@link createdCount}) in [0, 1]. */
  readonly unclaimedRatio: number;
  /** Age of the oldest unclaimed balance in milliseconds, 0 when none. */
  readonly oldestUnclaimedAgeMs: number;
  /** Distinct assets offered across created balances. */
  readonly assetDiversity: number;
  /** Summed amount across created balances. */
  readonly totalVolume: number;
  /** {@link totalVolume} / max(1, {@link createdCount}). */
  readonly averageAmount: number;
  /** True when all created balances carry the same (non-zero) amount. */
  readonly uniformAmount: boolean;
  /** True when any created balance carries an airdrop-marked memo. */
  readonly airdropMemoDetected: boolean;
  /** Distinct claimants with no other activity in the history besides claiming. */
  readonly unrelatedClaimants: number;
  /** {@link unrelatedClaimants} / max(1, {@link claimantsCount}) in [0, 1]. */
  readonly unrelatedRatio: number;
  /** Combined abuse severity in [0, 1], scaled by count, unclaimed ratio, burst, and velocity. */
  readonly abuseScore: number;
  /** Combined spam severity in [0, 1], scaled by recipient count and unrelatedness. */
  readonly spamScore: number;
  /** The recent window applied, in milliseconds. */
  readonly windowMs: number;
  /** The burst window applied, in milliseconds. */
  readonly burstWindowMs: number;
  /** The staleness threshold applied, in milliseconds. */
  readonly unclaimedAgeMs: number;
  /** Total transactions considered. */
  readonly totalCount: number;
  /** ISO-8601 reference time the windows end at. */
  readonly referenceTime: string;
}

function resolveReferenceTime(now: ClaimableBalanceOptions["now"]): number {
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

function resolveAccountId(accountId: string | undefined): string {
  if (typeof accountId !== "string" || accountId.trim().length === 0) {
    throw new ValidationError(
      "claimable balance features require the scored accountId (context.accountId or context.account.id)"
    );
  }
  return accountId.trim();
}

function resolvePositive(
  value: number | undefined,
  fallback: number,
  label: string
): number {
  const candidate = value ?? fallback;
  if (
    typeof candidate !== "number" ||
    !Number.isFinite(candidate) ||
    candidate <= 0
  ) {
    throw new ValidationError(`${label} must be a positive finite number`);
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

function parseTimestamp(value: string): number | undefined {
  if (typeof value !== "string" || value.length === 0) {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function operationType(transaction: Transaction): string {
  return String(transaction.type ?? "")
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

function isCreateClaimableBalance(transaction: Transaction): boolean {
  return operationType(transaction) === "create_claimable_balance";
}

function isClaimClaimableBalance(transaction: Transaction): boolean {
  return operationType(transaction) === "claim_claimable_balance";
}

function assetKey(transaction: Transaction): string {
  const code = transaction.assetCode ?? "XLM";
  return `${code}:${transaction.assetIssuer ?? ""}`;
}

/**
 * Claimants of a created balance: `claimants` when present (deduplicated,
 * first-seen order), otherwise the `to` recipient when present.
 */
function claimantsOf(transaction: Transaction): string[] {
  const raw = transaction.claimants;
  if (Array.isArray(raw) && raw.length > 0) {
    const seen = new Set<string>();
    const claimants: string[] = [];
    for (const entry of raw) {
      if (typeof entry !== "string") {
        continue;
      }
      const trimmed = entry.trim();
      if (trimmed.length === 0 || seen.has(trimmed)) {
        continue;
      }
      seen.add(trimmed);
      claimants.push(trimmed);
    }
    if (claimants.length > 0) {
      return claimants;
    }
  }
  const fallback = transaction.to;
  if (typeof fallback === "string" && fallback.trim().length > 0) {
    return [fallback];
  }
  return [];
}

/** Maximum number of timestamps inside any sliding window of `windowMs`. */
function maxInSlidingWindow(
  timestamps: readonly number[],
  windowMs: number
): number {
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

interface CreatedBalanceEntry {
  readonly timestamp?: number;
  readonly balanceId?: string;
}

/**
 * Computes claimable-balance features from a normalized history.
 *
 * @param transactions - Normalized transactions (issue #13).
 * @param options - Scored account (required), windows, thresholds.
 * @returns Deterministic {@link ClaimableBalanceFeatures}.
 */
export function extractClaimableBalanceFeatures(
  transactions: readonly Transaction[],
  options: ClaimableBalanceOptions = {}
): ClaimableBalanceFeatures {
  if (!Array.isArray(transactions)) {
    throw new ValidationError("transactions must be an array");
  }
  const accountId = resolveAccountId(options.accountId);
  const reference = resolveReferenceTime(options.now);
  const windowMs = resolvePositive(
    options.windowMs,
    DEFAULT_CLAIMABLE_BALANCE_WINDOW_MS,
    "windowMs"
  );
  const burstWindowMs = resolvePositive(
    options.burstWindowMs,
    DEFAULT_CLAIMABLE_BALANCE_BURST_WINDOW_MS,
    "burstWindowMs"
  );
  const burstThreshold = resolvePositive(
    options.burstThreshold,
    DEFAULT_CLAIMABLE_BALANCE_BURST_THRESHOLD,
    "burstThreshold"
  );
  const extremeCount = resolvePositive(
    options.extremeCount,
    DEFAULT_CLAIMABLE_BALANCE_EXTREME_COUNT,
    "extremeCount"
  );
  const unclaimedAgeMs = resolvePositive(
    options.unclaimedAgeMs,
    DEFAULT_CLAIMABLE_BALANCE_UNCLAIMED_AGE_MS,
    "unclaimedAgeMs"
  );
  const spamRecipientThreshold = resolvePositive(
    options.spamRecipientThreshold,
    DEFAULT_CLAIMABLE_BALANCE_SPAM_RECIPIENT_THRESHOLD,
    "spamRecipientThreshold"
  );

  const windowStart = reference - windowMs;
  const claimants = new Set<string>();
  const claimantsInWindow = new Set<string>();
  const assets = new Set<string>();
  const timestamps: number[] = [];
  const created: CreatedBalanceEntry[] = [];
  // Counterparties seen in any non-claimable-balance record: used to tell
  // claimants the scored account already interacts with (related) from
  // cold accounts that only exist as claim targets (unrelated).
  const knownCounterparties = new Set<string>();

  let createdCount = 0;
  let createdCountInWindow = 0;
  let claimObservedCount = 0;
  let totalVolume = 0;
  let firstAmount: number | undefined;
  let uniformAmount = true;
  let airdropMemoDetected = false;

  for (const transaction of transactions) {
    if (!transaction || typeof transaction !== "object") {
      continue;
    }
    const isCreate = isCreateClaimableBalance(transaction);
    const isClaim = isClaimClaimableBalance(transaction);

    // Track ordinary counterparties for the relatedness heuristic.
    if (!isCreate && !isClaim) {
      const source = transaction.sourceAccount;
      if (typeof source === "string" && source.trim().length > 0) {
        knownCounterparties.add(source);
      }
      for (const key of [transaction.from, transaction.to]) {
        if (typeof key === "string" && key.trim().length > 0) {
          knownCounterparties.add(key);
        }
      }
    }

    if (isClaim) {
      claimObservedCount += 1;
      continue;
    }

    if (!isCreate) {
      continue;
    }
    const source = transaction.from ?? transaction.sourceAccount;
    if (source !== accountId) {
      continue;
    }
    createdCount += 1;
    const ts = parseTimestamp(transaction.createdAt);
    if (ts !== undefined) {
      timestamps.push(ts);
      if (ts >= windowStart && ts <= reference) {
        createdCountInWindow += 1;
      }
    }
    const balanceId =
      typeof transaction.balanceId === "string" &&
      transaction.balanceId.trim().length > 0
        ? transaction.balanceId
        : undefined;
    created.push({ timestamp: ts, balanceId });

    const claimantList = claimantsOf(transaction);
    for (const claimant of claimantList) {
      claimants.add(claimant);
      if (
        ts !== undefined &&
        ts >= windowStart &&
        ts <= reference
      ) {
        claimantsInWindow.add(claimant);
      }
    }

    assets.add(assetKey(transaction));
    const amount =
      typeof transaction.amount === "number" &&
      Number.isFinite(transaction.amount)
        ? transaction.amount
        : 0;
    totalVolume += amount;
    if (firstAmount === undefined) {
      firstAmount = amount;
    } else if (Math.abs(amount - firstAmount) > 1e-7) {
      uniformAmount = false;
    }
    if (
      typeof transaction.memo === "string" &&
      CLAIMABLE_BALANCE_AIRDROP_MEMO_PATTERN.test(transaction.memo)
    ) {
      airdropMemoDetected = true;
    }
  }

  // Match observed claims to created balances by balance id.
  const claimedBalanceIds = new Set<string>();
  for (const transaction of transactions) {
    if (!transaction || typeof transaction !== "object") {
      continue;
    }
    if (!isClaimClaimableBalance(transaction)) {
      continue;
    }
    const balanceId =
      typeof transaction.balanceId === "string" &&
      transaction.balanceId.trim().length > 0
        ? transaction.balanceId
        : undefined;
    if (balanceId !== undefined) {
      claimedBalanceIds.add(balanceId);
    }
  }

  let unclaimedCount = 0;
  let oldestUnclaimedAgeMs = 0;
  for (const entry of created) {
    if (entry.balanceId !== undefined && claimedBalanceIds.has(entry.balanceId)) {
      continue;
    }
    if (entry.timestamp === undefined) {
      // Without a timestamp we cannot establish staleness; skip rather
      // than inflate the unclaimed count.
      continue;
    }
    const age = Math.max(0, reference - entry.timestamp);
    if (age < unclaimedAgeMs) {
      continue;
    }
    unclaimedCount += 1;
    if (age > oldestUnclaimedAgeMs) {
      oldestUnclaimedAgeMs = age;
    }
  }

  const claimantsCount = claimants.size;
  const unclaimedRatio =
    createdCount > 0 ? clamp01(unclaimedCount / createdCount) : 0;
  const assetDiversity = assets.size;
  const averageAmount =
    createdCount > 0
      ? Math.round((totalVolume / createdCount) * 10_000_000) / 10_000_000
      : 0;
  const uniform =
    uniformAmount && firstAmount !== undefined && firstAmount > 0 && createdCount > 0;

  let unrelatedClaimants = 0;
  for (const claimant of claimants) {
    if (!knownCounterparties.has(claimant)) {
      unrelatedClaimants += 1;
    }
  }
  const unrelatedRatio =
    claimantsCount > 0 ? clamp01(unrelatedClaimants / claimantsCount) : 0;

  timestamps.sort((a, b) => a - b);
  const burstCount = maxInSlidingWindow(timestamps, burstWindowMs);
  const burstDetected = burstCount >= burstThreshold;
  const extremeCountDetected = claimantsCount >= extremeCount;

  const countFactor = clamp01(createdCount / extremeCount);
  const unclaimedFactor = unclaimedRatio;
  const burstFactor = clamp01(burstCount / burstThreshold);
  const windowFactor = clamp01(createdCountInWindow / burstThreshold);
  const abuseScore = clamp01(
    countFactor * 0.3 +
      unclaimedFactor * 0.35 +
      burstFactor * 0.2 +
      windowFactor * 0.15
  );

  const recipientFactor =
    Math.min(claimantsCount / Math.max(spamRecipientThreshold, 1), 3) / 3;
  const spamScore = clamp01(
    recipientFactor * 0.5 + unrelatedRatio * 0.35 + burstFactor * 0.15
  );

  return {
    createdCount,
    claimantsCount,
    claimantsCountInWindow: claimantsInWindow.size,
    createdCountInWindow,
    burstCount,
    burstDetected,
    extremeCountDetected,
    claimObservedCount,
    unclaimedCount,
    unclaimedRatio,
    oldestUnclaimedAgeMs,
    assetDiversity,
    totalVolume: Math.round(totalVolume * 10_000_000) / 10_000_000,
    averageAmount,
    uniformAmount: uniform,
    airdropMemoDetected,
    unrelatedClaimants,
    unrelatedRatio,
    abuseScore,
    spamScore,
    windowMs,
    burstWindowMs,
    unclaimedAgeMs,
    totalCount: transactions.length,
    referenceTime: new Date(reference).toISOString(),
  };
}

/**
 * Flattens claimable-balance features into the uniform map (#24).
 */
export function claimableBalanceFeaturesToFeatureMap(
  features: ClaimableBalanceFeatures
): FeatureMap {
  return {
    claimableBalanceCreatedCount: features.createdCount,
    claimableBalanceClaimantsCount: features.claimantsCount,
    claimableBalanceClaimantsCountInWindow: features.claimantsCountInWindow,
    claimableBalanceCreatedCountInWindow: features.createdCountInWindow,
    claimableBalanceBurstCount: features.burstCount,
    claimableBalanceBurstDetected: features.burstDetected,
    claimableBalanceExtremeCountDetected: features.extremeCountDetected,
    claimableBalanceClaimObservedCount: features.claimObservedCount,
    claimableBalanceUnclaimedCount: features.unclaimedCount,
    claimableBalanceUnclaimedRatio: features.unclaimedRatio,
    claimableBalanceOldestUnclaimedAgeMs: features.oldestUnclaimedAgeMs,
    claimableBalanceAssetDiversity: features.assetDiversity,
    claimableBalanceTotalVolume: features.totalVolume,
    claimableBalanceAverageAmount: features.averageAmount,
    claimableBalanceUniformAmount: features.uniformAmount,
    claimableBalanceAirdropMemo: features.airdropMemoDetected,
    claimableBalanceAbuseScore: features.abuseScore,
    unsolicitedClaimSpamDistinctClaimants: features.claimantsCount,
    unsolicitedClaimSpamUnrelatedClaimants: features.unrelatedClaimants,
    unsolicitedClaimSpamUnrelatedRatio: features.unrelatedRatio,
    unsolicitedClaimSpamScore: features.spamScore,
    claimableBalanceWindowMs: features.windowMs,
    claimableBalanceBurstWindowMs: features.burstWindowMs,
    claimableBalanceUnclaimedAgeMs: features.unclaimedAgeMs,
  };
}

/** Options for {@link createClaimableBalanceFeatureProvider}. */
export interface ClaimableBalanceProviderOptions extends ClaimableBalanceOptions {}

/**
 * Creates a registry-ready claimable-balance provider (#24, #31, #32).
 */
export function createClaimableBalanceFeatureProvider(
  options: ClaimableBalanceProviderOptions = {}
): FeatureProvider {
  return {
    name: "claimableBalances",
    compute(context: FeatureContext): FeatureMap {
      const accountId =
        context.accountId ?? context.account?.id ?? options.accountId;
      const features = extractClaimableBalanceFeatures(context.transactions, {
        accountId,
        now: context.now ?? options.now,
        windowMs: options.windowMs,
        burstWindowMs: options.burstWindowMs,
        burstThreshold: options.burstThreshold,
        extremeCount: options.extremeCount,
        unclaimedAgeMs: options.unclaimedAgeMs,
        spamRecipientThreshold: options.spamRecipientThreshold,
      });
      return claimableBalanceFeaturesToFeatureMap(features);
    },
  };
}
