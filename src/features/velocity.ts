/**
 * Velocity feature extraction (issue #19).
 *
 * Velocity — how fast an account transacts — is one of the strongest
 * signals for automated or suspicious behavior (README.md). This module
 * derives counts and rates over configurable time windows from the
 * normalized transaction history (#13), so detectors and statistical
 * models share one deterministic representation.
 *
 * Contract:
 * - Windows are configurable and validated up front.
 * - Counts are inclusive of the reference time and exclusive of the
 *   window start (`reference - durationMs <= t <= reference`).
 * - Transactions without a parseable timestamp are ignored by time
 *   windows but still count toward totals and ledger averages.
 * - Empty or sparse histories yield zeroed features, never errors.
 */

import type { Transaction } from "../clients/horizon.js";
import { ValidationError } from "../errors.js";
import type {
  FeatureContext,
  FeatureMap,
  FeatureProvider,
} from "./types.js";

/** A configurable velocity window. */
export interface VelocityWindow {
  /** Stable window name, e.g. "1h", "24h", "7d". */
  readonly name: string;
  /** Window duration in milliseconds (must be > 0). */
  readonly durationMs: number;
}

/** Default windows used when callers do not supply their own. */
export const DEFAULT_VELOCITY_WINDOWS: readonly VelocityWindow[] = [
  { name: "1h", durationMs: 60 * 60 * 1000 },
  { name: "24h", durationMs: 24 * 60 * 60 * 1000 },
];

/** Milliseconds in one day; fixed 24h counterparty semantics. */
const DAY_MS = 24 * 60 * 60 * 1000;

/** Options for {@link extractVelocityFeatures}. */
export interface VelocityOptions {
  /** Time windows to count; defaults to {@link DEFAULT_VELOCITY_WINDOWS}. */
  readonly windows?: readonly VelocityWindow[];
  /** Reference time for the windows; defaults to `Date.now()`. */
  readonly now?: Date | string | number;
  /** Account being scored, excluded from counterparty counts. */
  readonly accountId?: string;
}

/** Velocity features for one account history. */
export interface VelocityFeatures {
  /** Transactions in the last hour (0 when no "1h" window is configured). */
  readonly txCount1h: number;
  /** Transactions in the last 24 hours (0 when no "24h" window is configured). */
  readonly txCount24h: number;
  /** Average transactions per distinct ledger across the whole history. */
  readonly txPerLedger: number;
  /** Distinct counterparties seen in the last 24 hours. */
  readonly uniqueCounterparties24h: number;
  /** Total transactions considered (including invalid timestamps). */
  readonly totalCount: number;
  /** Distinct ledgers present in the history. */
  readonly uniqueLedgers: number;
  /** Counts keyed by the configured window name. */
  readonly windowCounts: Readonly<Record<string, number>>;
  /** The configured windows, in input order. */
  readonly windows: readonly VelocityWindow[];
  /** ISO-8601 reference time the windows end at. */
  readonly referenceTime: string;
}

function resolveWindows(
  windows: readonly VelocityWindow[] | undefined
): readonly VelocityWindow[] {
  const candidate = windows ?? DEFAULT_VELOCITY_WINDOWS;
  if (!Array.isArray(candidate) || candidate.length === 0) {
    throw new ValidationError("At least one velocity window is required");
  }

  const seen = new Set<string>();
  return candidate.map((window, index) => {
    if (
      !window ||
      typeof window.name !== "string" ||
      window.name.trim().length === 0
    ) {
      throw new ValidationError(
        `Velocity window at index ${index} must have a non-empty name`
      );
    }
    const name = window.name.trim();
    if (seen.has(name)) {
      throw new ValidationError(`Duplicate velocity window name "${name}"`);
    }
    if (
      typeof window.durationMs !== "number" ||
      !Number.isFinite(window.durationMs) ||
      window.durationMs <= 0
    ) {
      throw new ValidationError(
        `Velocity window "${name}" must have a positive finite durationMs`
      );
    }
    seen.add(name);
    return { name, durationMs: window.durationMs };
  });
}

function resolveReferenceTime(now: VelocityOptions["now"]): number {
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

/** Adds every non-empty party other than the scored account. */
function addCounterparties(
  transaction: Transaction,
  accountId: string | undefined,
  into: Set<string>
): void {
  const candidates = [transaction.to, transaction.from, transaction.sourceAccount];
  for (const candidate of candidates) {
    if (
      typeof candidate === "string" &&
      candidate.length > 0 &&
      candidate !== accountId
    ) {
      into.add(candidate);
    }
  }
}

/**
 * Computes velocity features from a normalized transaction history.
 *
 * @param transactions - Normalized transactions (issue #13).
 * @param options - Window sizes, reference time, and the scored account.
 * @returns Deterministic {@link VelocityFeatures}.
 * @throws {ValidationError} If windows or the reference time are invalid.
 *
 * @example
 * ```ts
 * const features = extractVelocityFeatures(transactions, {
 *   now: "2026-01-01T12:00:00Z",
 *   accountId: "GABC...",
 *   windows: [
 *     { name: "1h", durationMs: 3_600_000 },
 *     { name: "24h", durationMs: 86_400_000 },
 *   ],
 * });
 * features.txCount1h; // 4
 * ```
 */
export function extractVelocityFeatures(
  transactions: readonly Transaction[],
  options: VelocityOptions = {}
): VelocityFeatures {
  if (!Array.isArray(transactions)) {
    throw new ValidationError("transactions must be an array");
  }

  const windows = resolveWindows(options.windows);
  const reference = resolveReferenceTime(options.now);
  const windowCounts: Record<string, number> = {};
  for (const window of windows) {
    windowCounts[window.name] = 0;
  }

  const ledgers = new Set<number>();
  const counterparties24h = new Set<string>();

  for (const transaction of transactions) {
    if (!transaction || typeof transaction !== "object") {
      continue;
    }

    const ledger = transaction.ledger;
    if (typeof ledger === "number" && Number.isFinite(ledger) && ledger >= 0) {
      ledgers.add(ledger);
    }

    const timestamp = parseTimestamp(transaction.createdAt);
    if (timestamp === undefined || timestamp > reference) {
      continue;
    }

    for (const window of windows) {
      const start = reference - window.durationMs;
      if (timestamp >= start) {
        windowCounts[window.name] += 1;
      }
    }

    if (timestamp >= reference - DAY_MS) {
      addCounterparties(transaction, options.accountId, counterparties24h);
    }
  }

  const totalCount = transactions.length;
  const uniqueLedgers = ledgers.size;

  return {
    txCount1h: windowCounts["1h"] ?? 0,
    txCount24h: windowCounts["24h"] ?? 0,
    txPerLedger: uniqueLedgers > 0 ? totalCount / uniqueLedgers : 0,
    uniqueCounterparties24h: counterparties24h.size,
    totalCount,
    uniqueLedgers,
    windowCounts,
    windows,
    referenceTime: new Date(reference).toISOString(),
  };
}

/** Converts a window name into a safe feature-map key segment. */
function featureKeySegment(name: string): string {
  return name.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

/**
 * Flattens velocity features into the registry's uniform map (#24).
 *
 * @param features - Output of {@link extractVelocityFeatures}.
 * @returns Scalar feature values keyed for downstream consumers.
 */
export function velocityFeaturesToFeatureMap(
  features: VelocityFeatures
): FeatureMap {
  const map: FeatureMap = {
    txCount1h: features.txCount1h,
    txCount24h: features.txCount24h,
    txPerLedger: features.txPerLedger,
    uniqueCounterparties24h: features.uniqueCounterparties24h,
    velocityTotalCount: features.totalCount,
    velocityUniqueLedgers: features.uniqueLedgers,
  };

  for (const [name, count] of Object.entries(features.windowCounts)) {
    map[`txCount_${featureKeySegment(name)}`] = count;
  }

  return map;
}

/**
 * Creates a registry-ready velocity provider (#19, #24).
 *
 * @param options - Defaults; `context.now` and `context.accountId` win.
 */
export function createVelocityFeatureProvider(
  options: VelocityOptions = {}
): FeatureProvider {
  return {
    name: "velocity",
    compute(context: FeatureContext): FeatureMap {
      const features = extractVelocityFeatures(context.transactions, {
        windows: options.windows,
        now: context.now ?? options.now,
        accountId: context.accountId ?? options.accountId,
      });
      return velocityFeaturesToFeatureMap(features);
    },
  };
}
