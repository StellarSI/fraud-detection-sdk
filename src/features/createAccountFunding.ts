/**
 * Create-account funding pattern feature extraction (issue #30).
 *
 * "Accounts funded via `create_account` (`README.md:19`) — especially
 * many small accounts funded by the same source — have no detector."
 * This module derives funding-source and mass-funding signals from the
 * normalized transaction history (#13) so the create-account funding
 * rule (#30, #25) can flag sybil / mass-creation patterns.
 *
 * - **Funding source** — `create_account` operations that created this
 *   account (targeting it). Exposes the funding source address when
 *   visible in the history.
 * - **Funding activity** — `create_account` operations performed by this
 *   account (funding others), total and distinct recipients.
 * - **Velocity / burst** — funding operations inside a window and the
 *   maximum number inside any sliding burst window, to flag many
 *   accounts funded by the same source within a short window.
 *
 * Contract:
 * - The scored account is required for attribution.
 * - Transactions without a parseable timestamp still count toward totals
 *   but cannot contribute to window/burst math.
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

/** Default window for counting recent create-account funding: 24 hours. */
export const DEFAULT_CREATE_ACCOUNT_FUNDING_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Default sliding window for a funding burst: 1 hour. */
export const DEFAULT_CREATE_ACCOUNT_FUNDING_BURST_WINDOW_MS = 60 * 60 * 1000;

/** Default number of create-account ops inside the burst window that is a burst. */
export const DEFAULT_CREATE_ACCOUNT_FUNDING_BURST_THRESHOLD = 5;

/** Default funded-account count treated as extreme mass funding. */
export const DEFAULT_CREATE_ACCOUNT_FUNDING_EXTREME_COUNT = 20;

/** Options for {@link extractCreateAccountFundingFeatures}. */
export interface CreateAccountFundingOptions {
  /** Account being scored (required). */
  readonly accountId?: string;
  /** Reference time for windows; defaults to `Date.now()`. */
  readonly now?: Date | string | number;
  /** Window for recent funding activity. Default: 24 hours. */
  readonly windowMs?: number;
  /** Sliding burst window. Default: 1 hour. */
  readonly burstWindowMs?: number;
  /** Funding ops in the burst window that count as a burst. Default: 5. */
  readonly burstThreshold?: number;
  /** Distinct funded accounts treated as extreme. Default: 20. */
  readonly extremeCount?: number;
}

/** Create-account funding features for one account history. */
export interface CreateAccountFundingFeatures {
  /** Funding source address that created this account, when visible in history. */
  readonly fundingSource: string | null;
  /** Distinct funding sources observed creating this account. */
  readonly fundingSourceCount: number;
  /** `create_account` operations performed by this account (funding others). */
  readonly fundingCount: number;
  /** Distinct accounts funded by this account. */
  readonly fundedAccountsCount: number;
  /** Funding operations inside the recent window. */
  readonly fundingCountInWindow: number;
  /** Distinct accounts funded inside the recent window. */
  readonly fundedAccountsInWindowCount: number;
  /** Maximum funding operations inside any sliding burst window. */
  readonly burstCount: number;
  /** True when {@link burstCount} reaches the burst threshold. */
  readonly burstDetected: boolean;
  /** True when funded account count reaches the extreme threshold. */
  readonly extremeCountDetected: boolean;
  /** Combined severity in [0, 1], scaled by count, burst, and velocity. */
  readonly fundingScore: number;
  /** The recent window applied, in milliseconds. */
  readonly windowMs: number;
  /** The burst window applied, in milliseconds. */
  readonly burstWindowMs: number;
  /** Total transactions considered. */
  readonly totalCount: number;
  /** ISO-8601 reference time the windows end at. */
  readonly referenceTime: string;
}

function resolveReferenceTime(now: CreateAccountFundingOptions["now"]): number {
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
      "create-account funding features require the scored accountId (context.accountId or context.account.id)"
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
  if (typeof candidate !== "number" || !Number.isFinite(candidate) || candidate <= 0) {
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

function isCreateAccountType(transaction: Transaction): boolean {
  return operationType(transaction) === "create_account";
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
 * Computes create-account funding features from a normalized history.
 *
 * @param transactions - Normalized transactions (issue #13).
 * @param options - Scored account (required), windows, thresholds.
 * @returns Deterministic {@link CreateAccountFundingFeatures}.
 */
export function extractCreateAccountFundingFeatures(
  transactions: readonly Transaction[],
  options: CreateAccountFundingOptions = {}
): CreateAccountFundingFeatures {
  if (!Array.isArray(transactions)) {
    throw new ValidationError("transactions must be an array");
  }
  const accountId = resolveAccountId(options.accountId);
  const reference = resolveReferenceTime(options.now);
  const windowMs = resolvePositive(
    options.windowMs,
    DEFAULT_CREATE_ACCOUNT_FUNDING_WINDOW_MS,
    "windowMs"
  );
  const burstWindowMs = resolvePositive(
    options.burstWindowMs,
    DEFAULT_CREATE_ACCOUNT_FUNDING_BURST_WINDOW_MS,
    "burstWindowMs"
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

  const windowStart = reference - windowMs;
  const incomingSources = new Set<string>();
  let firstIncomingSource: string | null = null;
  let fundingCount = 0;
  let fundingCountInWindow = 0;
  const fundedAccounts = new Set<string>();
  const fundedAccountsInWindow = new Set<string>();
  const timestamps: number[] = [];

  for (const transaction of transactions) {
    if (!transaction || typeof transaction !== "object") {
      continue;
    }
    if (!isCreateAccountType(transaction)) {
      continue;
    }
    const source = transaction.from ?? transaction.sourceAccount;
    const target = transaction.to;
    const ts = parseTimestamp(transaction.createdAt);

    // This account was created/funded by someone (incoming funding source).
    if (target === accountId && typeof source === "string" && source.length > 0) {
      incomingSources.add(source);
      if (firstIncomingSource === null) {
        firstIncomingSource = source;
      }
    }

    // This account funded others (outgoing mass-funding pattern).
    if (source === accountId && typeof target === "string" && target.length > 0) {
      fundingCount += 1;
      fundedAccounts.add(target);
      if (ts !== undefined) {
        timestamps.push(ts);
        if (ts >= windowStart && ts <= reference) {
          fundingCountInWindow += 1;
          fundedAccountsInWindow.add(target);
        }
      }
    }
  }

  timestamps.sort((a, b) => a - b);
  const burstCount = maxInSlidingWindow(timestamps, burstWindowMs);
  const fundedAccountsCount = fundedAccounts.size;
  const burstDetected = burstCount >= burstThreshold;
  const extremeCountDetected = fundedAccountsCount >= extremeCount;

  const countFactor = clamp01(fundedAccountsCount / extremeCount);
  const burstFactor = clamp01(burstCount / burstThreshold);
  const windowFactor = clamp01(fundingCountInWindow / burstThreshold);
  const velocityFactor = clamp01(fundingCountInWindow / Math.max(1, extremeCount));
  const fundingScore = clamp01(
    countFactor * 0.35 +
      burstFactor * 0.3 +
      windowFactor * 0.2 +
      velocityFactor * 0.15
  );

  return {
    fundingSource: firstIncomingSource,
    fundingSourceCount: incomingSources.size,
    fundingCount,
    fundedAccountsCount,
    fundingCountInWindow,
    fundedAccountsInWindowCount: fundedAccountsInWindow.size,
    burstCount,
    burstDetected,
    extremeCountDetected,
    fundingScore,
    windowMs,
    burstWindowMs,
    totalCount: transactions.length,
    referenceTime: new Date(reference).toISOString(),
  };
}

/**
 * Flattens create-account funding features into the uniform map (#24).
 */
export function createAccountFundingFeaturesToFeatureMap(
  features: CreateAccountFundingFeatures
): FeatureMap {
  return {
    createAccountFundingSource: features.fundingSource,
    createAccountFundingSourceCount: features.fundingSourceCount,
    createAccountFundingCount: features.fundingCount,
    createAccountFundedAccountsCount: features.fundedAccountsCount,
    createAccountFundingCountInWindow: features.fundingCountInWindow,
    createAccountFundedAccountsInWindowCount: features.fundedAccountsInWindowCount,
    createAccountFundingBurstCount: features.burstCount,
    createAccountFundingBurstDetected: features.burstDetected,
    createAccountFundingExtremeCountDetected: features.extremeCountDetected,
    createAccountFundingScore: features.fundingScore,
    createAccountFundingWindowMs: features.windowMs,
    createAccountFundingBurstWindowMs: features.burstWindowMs,
  };
}

/** Options for {@link createCreateAccountFundingFeatureProvider}. */
export interface CreateAccountFundingProviderOptions
  extends CreateAccountFundingOptions {}

/**
 * Creates a registry-ready create-account funding provider (#24, #30).
 */
export function createCreateAccountFundingFeatureProvider(
  options: CreateAccountFundingProviderOptions = {}
): FeatureProvider {
  return {
    name: "createAccountFunding",
    compute(context: FeatureContext): FeatureMap {
      const accountId =
        context.accountId ?? context.account?.id ?? options.accountId;
      const features = extractCreateAccountFundingFeatures(context.transactions, {
        accountId,
        now: context.now ?? options.now,
        windowMs: options.windowMs,
        burstWindowMs: options.burstWindowMs,
        burstThreshold: options.burstThreshold,
        extremeCount: options.extremeCount,
      });
      return createAccountFundingFeaturesToFeatureMap(features);
    },
  };
}
