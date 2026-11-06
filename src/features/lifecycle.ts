/**
 * Account lifecycle feature extraction (issue #23).
 *
 * "Fresh accounts funded via `create_account`, rapid merges, and throwaway
 * accounts" (README.md) are headline Stellar abuse patterns. This module
 * derives lifecycle signals from the normalized account (#12) and
 * transaction history (#13) so detectors and models can share one
 * deterministic representation:
 *
 * - **Account age** — from `create_account` ledgers/timestamps in the
 *   history when present, otherwise from the first-seen transaction as a
 *   lower bound. `ageMs` (and `ageLedgers`) are computed against the
 *   reference time / newest ledger observed, never wall-clock when a
 *   reference is supplied.
 * - **Funding** — `create_account` operations this account performed
 *   (`createAccountCount`, `fundedAccountsCount`) and `create_account`
 *   operations targeting this account (`accountFundedByCount`), i.e. its
 *   own creation funding.
 * - **Merges** — `account_merge` transactions executed by this account
 *   (`mergeCount`), time-to-first-merge (`msToFirstMerge`), merges per
 *   day (`mergesPerDay`) and a `rapidMergeFlag` when the first merge
 *   happens within `rapidMergeWindowMs` of account creation/first-seen
 *   (default 7 days).
 *
 * Contract:
 * - The scored account is required: lifecycle attribution without an
 *   account id is meaningless, so it throws a `ValidationError`.
 * - Transactions without a parseable ledger or timestamp still count
 *   toward operation tallies; they just cannot contribute to time-based
 *   ledger math.
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

/** Milliseconds in one day; fixed-day counterparty semantics. */
const DAY_MS = 24 * 60 * 60 * 1000;

/** Default window after creation/first-seen during which a merge is "rapid". */
export const DEFAULT_RAPID_MERGE_WINDOW_MS = 7 * DAY_MS;

/** Options for {@link extractLifecycleFeatures}. */
export interface LifecycleOptions {
  /** Reference time for age math; defaults to `Date.now()`. */
  readonly now?: Date | string | number;
  /** Account being scored (required). */
  readonly accountId?: string;
  /** Window within which a post-creation merge counts as rapid; default {@link DEFAULT_RAPID_MERGE_WINDOW_MS}. */
  readonly rapidMergeWindowMs?: number;
}

/** Lifecycle features for one account history. */
export interface LifecycleFeatures {
  /** Milliseconds from creation/first-seen to the reference time (0 for empty histories). */
  readonly ageMs: number;
  /**
   * Ledgers elapsed since creation (when the creation ledger is known from
   * the history) or the span of the observed history otherwise. Lower
   * bounds when the full history is not available.
   */
  readonly ageLedgers: number;
  /** Ledger of the oldest transaction in the history; null when unknown. */
  readonly firstSeenLedger: number | null;
  /** Highest ledger observed in the history; null when unknown. */
  readonly latestLedgerSeen: number | null;
  /** Ledger this account was created in, when its `create_account` op is in the history. */
  readonly accountCreatedLedger: number | null;
  /** ISO-8601 timestamp of this account's creation, when its `create_account` op is in the history. */
  readonly accountCreatedAt: string | null;
  /** True when the history contains the `create_account` op that funded this account. */
  readonly accountCreatedInHistory: boolean;
  /** `create_account` operations executed by this account (funding others). */
  readonly createAccountCount: number;
  /** Distinct recipients funded by this account's `create_account` ops. */
  readonly fundedAccountsCount: number;
  /** `create_account` operations whose `to` is this account (its own creation funding). */
  readonly accountFundedByCount: number;
  /** `account_merge` transactions executed by this account. */
  readonly mergeCount: number;
  /** Merges per day since creation/first-seen (mergeCount for sub-day ages). */
  readonly mergesPerDay: number;
  /** Milliseconds from creation/first-seen to this account's first merge; null when never merged or unknown. */
  readonly msToFirstMerge: number | null;
  /** True when the first merge happened within `rapidMergeWindowMs` of creation/first-seen. */
  readonly rapidMergeFlag: boolean;
  /** The configured rapid-merge window, in milliseconds. */
  readonly rapidMergeWindowMs: number;
  /** Total transactions considered. */
  readonly totalCount: number;
  /** ISO-8601 reference time the age was computed at. */
  readonly referenceTime: string;
}

function resolveReferenceTime(now: LifecycleOptions["now"]): number {
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

function resolveRapidMergeWindowMs(value: number | undefined): number {
  const candidate = value ?? DEFAULT_RAPID_MERGE_WINDOW_MS;
  if (
    typeof candidate !== "number" ||
    !Number.isFinite(candidate) ||
    candidate <= 0
  ) {
    throw new ValidationError(
      "rapidMergeWindowMs must be a positive finite number"
    );
  }
  return candidate;
}

function resolveAccountId(accountId: string | undefined): string {
  if (typeof accountId !== "string" || accountId.trim().length === 0) {
    throw new ValidationError(
      "lifecycle features require the scored accountId (context.accountId or context.account.id)"
    );
  }
  return accountId.trim();
}

function parseTimestamp(value: string): number | undefined {
  if (typeof value !== "string" || value.length === 0) {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isLedger(value: Transaction["ledger"]): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** Normalizes Horizon's operation type spellings for comparison. */
function operationType(transaction: Transaction): string {
  return String(transaction.type ?? "")
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

function isCreateAccountType(transaction: Transaction): boolean {
  return operationType(transaction) === "create_account";
}

function isMergeType(transaction: Transaction): boolean {
  const type = operationType(transaction);
  return type === "account_merge" || type === "merge_account";
}

/**
 * Computes lifecycle features from a normalized transaction history.
 *
 * @param transactions - Normalized transactions (issue #13).
 * @param options - Scored account (required), reference time, merge window.
 * @returns Deterministic {@link LifecycleFeatures}.
 * @throws {ValidationError} If the account id, window, or reference time is invalid.
 */
export function extractLifecycleFeatures(
  transactions: readonly Transaction[],
  options: LifecycleOptions = {}
): LifecycleFeatures {
  if (!Array.isArray(transactions)) {
    throw new ValidationError("transactions must be an array");
  }
  const accountId = resolveAccountId(options.accountId);
  const reference = resolveReferenceTime(options.now);
  const rapidMergeWindowMs = resolveRapidMergeWindowMs(options.rapidMergeWindowMs);

  const ledgers: number[] = [];
  const timestamps: number[] = [];
  let createAccountCount = 0;
  let accountFundedByCount = 0;
  let accountCreatedLedger: number | null = null;
  let accountCreatedAtMs: number | null = null;
  let accountCreatedAt: string | null = null;
  let mergeCount = 0;
  let firstMergeMs: number | null = null;
  const fundedAccounts = new Set<string>();
  let oldestTimestamp: number | null = null;

  for (const transaction of transactions) {
    if (!transaction || typeof transaction !== "object") {
      continue;
    }
    if (isLedger(transaction.ledger)) {
      ledgers.push(transaction.ledger);
    }
    const ts = parseTimestamp(transaction.createdAt);
    if (ts !== undefined) {
      timestamps.push(ts);
      oldestTimestamp =
        oldestTimestamp === null ? ts : Math.min(oldestTimestamp, ts);
    }

    if (isCreateAccountType(transaction)) {
      const source = transaction.from ?? transaction.sourceAccount;
      const target = transaction.to;
      if (source === accountId && typeof target === "string" && target.length > 0) {
        createAccountCount += 1;
        fundedAccounts.add(target);
      }
      if (target === accountId) {
        accountFundedByCount += 1;
        if (isLedger(transaction.ledger)) {
          // Earliest creation funding wins; histories are usually newest-first.
          if (accountCreatedLedger === null || transaction.ledger < accountCreatedLedger) {
            accountCreatedLedger = transaction.ledger;
          }
        }
        if (ts !== undefined) {
          // Earliest creation funding wins; histories are usually newest-first.
          if (accountCreatedAtMs === null || ts < accountCreatedAtMs) {
            accountCreatedAtMs = ts;
            accountCreatedAt = transaction.createdAt;
          }
        }
      }
    }

    if (isMergeType(transaction)) {
      const source = transaction.sourceAccount ?? transaction.from;
      if (source === accountId) {
        mergeCount += 1;
        if (ts !== undefined && (firstMergeMs === null || ts < firstMergeMs)) {
          firstMergeMs = ts;
        }
      }
    }
  }

  const firstSeenLedger = ledgers.length > 0 ? Math.min(...ledgers) : null;
  const latestLedgerSeen = ledgers.length > 0 ? Math.max(...ledgers) : null;

  // Age anchor: exact creation funding when visible in the history, else the
  // first-seen transaction. Unknown otherwise (empty history).
  const ageAnchorMs = accountCreatedAtMs ?? oldestTimestamp;
  const ageMs =
    ageAnchorMs === null ? 0 : Math.max(0, reference - ageAnchorMs);

  let ageLedgers: number;
  if (accountCreatedLedger !== null && latestLedgerSeen !== null) {
    ageLedgers = Math.max(0, latestLedgerSeen - accountCreatedLedger);
  } else if (firstSeenLedger !== null && latestLedgerSeen !== null) {
    ageLedgers = Math.max(0, latestLedgerSeen - firstSeenLedger);
  } else {
    ageLedgers = 0;
  }

  const ageDays = ageMs / DAY_MS;
  const mergesPerDay =
    ageDays > 0 ? mergeCount / ageDays : mergeCount;

  const msToFirstMerge =
    firstMergeMs === null || ageAnchorMs === null
      ? null
      : Math.max(0, firstMergeMs - ageAnchorMs);

  return {
    ageMs,
    ageLedgers,
    firstSeenLedger,
    latestLedgerSeen,
    accountCreatedLedger,
    accountCreatedAt,
    accountCreatedInHistory: accountCreatedLedger !== null || accountCreatedAt !== null,
    createAccountCount,
    fundedAccountsCount: fundedAccounts.size,
    accountFundedByCount,
    mergeCount,
    mergesPerDay,
    msToFirstMerge,
    rapidMergeFlag:
      msToFirstMerge !== null && msToFirstMerge <= rapidMergeWindowMs,
    rapidMergeWindowMs,
    totalCount: transactions.length,
    referenceTime: new Date(reference).toISOString(),
  };
}

/**
 * Flattens lifecycle features into the registry's uniform map (#24).
 *
 * @param features - Output of {@link extractLifecycleFeatures}.
 * @returns Scalar feature values keyed for downstream consumers.
 */
export function lifecycleFeaturesToFeatureMap(
  features: LifecycleFeatures
): FeatureMap {
  return {
    accountAgeMs: features.ageMs,
    accountAgeLedgers: features.ageLedgers,
    accountFirstSeenLedger: features.firstSeenLedger,
    accountCreatedInHistory: features.accountCreatedInHistory,
    accountCreatedLedger: features.accountCreatedLedger,
    createAccountCount: features.createAccountCount,
    fundedAccountsCount: features.fundedAccountsCount,
    accountFundedByCount: features.accountFundedByCount,
    accountMergeCount: features.mergeCount,
    accountMergesPerDay: features.mergesPerDay,
    msToFirstMerge: features.msToFirstMerge,
    rapidMergeFlag: features.rapidMergeFlag,
    lifecycleTransactionCount: features.totalCount,
  };
}

/**
 * Creates a registry-ready lifecycle provider (#23, #24).
 *
 * @param options - Defaults; `context.now` and `context.accountId`
 *   (falling back to `context.account?.id`) win.
 */
export function createLifecycleFeatureProvider(
  options: LifecycleOptions = {}
): FeatureProvider {
  return {
    name: "lifecycle",
    compute(context: FeatureContext): FeatureMap {
      const accountId =
        context.accountId ?? context.account?.id ?? options.accountId;
      const features = extractLifecycleFeatures(context.transactions, {
        accountId,
        now: context.now ?? options.now,
        rapidMergeWindowMs: options.rapidMergeWindowMs,
      });
      return lifecycleFeaturesToFeatureMap(features);
    },
  };
}
