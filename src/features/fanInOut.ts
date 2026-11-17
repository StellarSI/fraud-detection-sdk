/**
 * Rapid fan-in / fan-out feature extraction (issue #37).
 *
 * Rapid fan-in / fan-out across many accounts within a few ledgers is a
 * headline Stellar abuse pattern (README.md:25) and the classic signature
 * of layering and value movement through intermediary accounts. This module
 * computes directed counterparty degrees over a small, bounded window and
 * exposes both the window-wide counts and the short-burst/per-ledger "speed"
 * needed to tell a sudden fan from steady, high-volume activity.
 *
 * - **Window** — by default the last {@link DEFAULT_FAN_WINDOW_LEDGERS}
 *   ledgers (relative to the newest ledger in the history, or an explicit
 *   reference ledger). An optional time window (`windowMs`, mirroring the
 *   velocity family #19) can be combined with the ledger window.
 * - **Direction** — fan-in counts distinct senders paying the scored
 *   account; fan-out counts distinct recipients it pays. Degrees reuse the
 *   bounded counterparty graph (#20, #46) so large histories stay bounded.
 * - **Speed** — distinct counterparties inside a shorter burst window and
 *   the peak distinct counterparties seen in any single ledger make a
 *   sudden burst distinguishable from steady activity.
 *
 * Contract:
 * - Missing/short histories yield zeroed features, never errors.
 * - Bounds are configurable; graph truncation is reported, not hidden.
 * - Computation is deterministic: identical context, identical output.
 */

import type { Transaction } from "../clients/horizon.js";
import { ValidationError } from "../errors.js";
import {
  CounterpartyGraph,
  buildCounterpartyGraph,
  DEFAULT_MAX_GRAPH_NODES,
  DEFAULT_MAX_GRAPH_EDGES,
} from "./graph.js";
import type {
  FeatureContext,
  FeatureMap,
  FeatureProvider,
} from "./types.js";

/** Default number of ledgers in the analysis window. */
export const DEFAULT_FAN_WINDOW_LEDGERS = 10;

/** Default number of ledgers in the short burst window. */
export const DEFAULT_FAN_BURST_LEDGERS = 3;

/** Options for {@link extractFanInOutFeatures}. */
export interface FanInOutOptions {
  /** Account being scored (required): degrees and bursts are relative to it. */
  readonly accountId?: string;
  /** Ledger window size, ending at the reference ledger. Default: 10. */
  readonly windowLedgers?: number;
  /** Burst window size in ledgers. Default: 3. */
  readonly burstLedgers?: number;
  /**
   * Optional time window in milliseconds, combined with the ledger window.
   * Disabled when omitted (ledger window only).
   */
  readonly windowMs?: number;
  /** Reference ledger; defaults to the newest ledger in the history. */
  readonly referenceLedger?: number;
  /** Reference time for `windowMs`; defaults to `Date.now()`. */
  readonly now?: Date | string | number;
  /** Maximum distinct graph nodes retained. Default: 10,000. */
  readonly maxNodes?: number;
  /** Maximum distinct graph edges retained. Default: 50,000. */
  readonly maxEdges?: number;
}

/** Rapid fan-in / fan-out features for one account. */
export interface FanInOutFeatures {
  /** Distinct senders paying the account inside the window. */
  readonly fanInDegree: number;
  /** Distinct recipients the account pays inside the window. */
  readonly fanOutDegree: number;
  /** {@link fanInDegree} + {@link fanOutDegree}. */
  readonly fanTotalDegree: number;
  /** Inbound transactions inside the window. */
  readonly fanInTxCount: number;
  /** Outbound transactions inside the window. */
  readonly fanOutTxCount: number;
  /** Distinct senders inside the short burst window. */
  readonly fanInBurstCount: number;
  /** Distinct recipients inside the short burst window. */
  readonly fanOutBurstCount: number;
  /** Peak distinct senders observed in any single ledger. */
  readonly fanPeakInPerLedger: number;
  /** Peak distinct recipients observed in any single ledger. */
  readonly fanPeakOutPerLedger: number;
  /** The ledger window applied. */
  readonly fanWindowLedgers: number;
  /** The burst window applied, in ledgers. */
  readonly fanBurstLedgers: number;
  /** The time window applied, in milliseconds; 0 when disabled. */
  readonly fanWindowMs: number;
  /** Transactions inside the window (for context). */
  readonly fanWindowTxCount: number;
  /** True when the bounded graph dropped nodes or edges. */
  readonly fanTruncated: boolean;
  /** Total transactions considered. */
  readonly fanTotalCount: number;
}

function resolveWindowLedgers(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_FAN_WINDOW_LEDGERS;
  }
  if (!Number.isInteger(value) || value < 1) {
    throw new ValidationError("windowLedgers must be a positive integer");
  }
  return value;
}

function resolveBurstLedgers(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_FAN_BURST_LEDGERS;
  }
  if (!Number.isInteger(value) || value < 1) {
    throw new ValidationError("burstLedgers must be a positive integer");
  }
  return value;
}

function resolveWindowMs(value: number | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new ValidationError("windowMs must be a positive finite number when provided");
  }
  return value;
}

function resolveAccountId(accountId: string | undefined): string {
  if (typeof accountId !== "string" || accountId.trim().length === 0) {
    throw new ValidationError("Fan in/out features require a non-empty accountId");
  }
  return accountId.trim();
}

function resolveReferenceLedger(
  transactions: readonly Transaction[],
  provided: number | undefined
): number | undefined {
  if (provided !== undefined) {
    if (!Number.isInteger(provided) || provided < 0) {
      throw new ValidationError("referenceLedger must be a non-negative integer");
    }
    return provided;
  }
  let newest = -1;
  for (const transaction of transactions) {
    if (!transaction || typeof transaction !== "object") {
      continue;
    }
    const ledger = transaction.ledger;
    if (typeof ledger === "number" && Number.isFinite(ledger) && ledger >= 0 && ledger > newest) {
      newest = ledger;
    }
  }
  return newest >= 0 ? newest : undefined;
}

function resolveReferenceTime(now: FanInOutOptions["now"]): number {
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

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function addToLedgerMap(
  map: Map<number, Set<string>>,
  ledger: number,
  party: string
): void {
  let set = map.get(ledger);
  if (!set) {
    set = new Set<string>();
    map.set(ledger, set);
  }
  set.add(party);
}

/**
 * Computes rapid fan-in / fan-out features from a normalized history.
 *
 * @param transactions - Normalized transactions (issue #13).
 * @param options - Account, window, burst and bound configuration.
 * @returns Deterministic {@link FanInOutFeatures}.
 * @throws {ValidationError} If inputs or options are invalid.
 */
export function extractFanInOutFeatures(
  transactions: readonly Transaction[],
  options: FanInOutOptions = {}
): FanInOutFeatures {
  if (!Array.isArray(transactions)) {
    throw new ValidationError("transactions must be an array");
  }

  const accountId = resolveAccountId(options.accountId);
  const windowLedgers = resolveWindowLedgers(options.windowLedgers);
  const burstLedgers = resolveBurstLedgers(options.burstLedgers);
  const windowMs = resolveWindowMs(options.windowMs);
  const maxNodes =
    options.maxNodes === undefined
      ? DEFAULT_MAX_GRAPH_NODES
      : options.maxNodes;
  const maxEdges =
    options.maxEdges === undefined
      ? DEFAULT_MAX_GRAPH_EDGES
      : options.maxEdges;

  const referenceLedger = resolveReferenceLedger(
    transactions,
    options.referenceLedger
  );
  const windowStart =
    referenceLedger === undefined ? -Infinity : referenceLedger - windowLedgers + 1;
  const burstStart =
    referenceLedger === undefined ? -Infinity : referenceLedger - burstLedgers + 1;

  const reference = resolveReferenceTime(options.now);
  const timeStart = windowMs === undefined ? undefined : reference - windowMs;

  const windowed: Transaction[] = [];
  const inSenders = new Set<string>();
  const outRecipients = new Set<string>();
  const inBurst = new Set<string>();
  const outBurst = new Set<string>();
  const inByLedger = new Map<number, Set<string>>();
  const outByLedger = new Map<number, Set<string>>();
  let fanInTxCount = 0;
  let fanOutTxCount = 0;

  for (const transaction of transactions) {
    if (!transaction || typeof transaction !== "object") {
      continue;
    }

    // Ledger window (when ledger information is available).
    if (referenceLedger !== undefined) {
      const ledger = transaction.ledger;
      if (
        typeof ledger !== "number" ||
        !Number.isFinite(ledger) ||
        ledger < windowStart ||
        ledger > referenceLedger
      ) {
        continue;
      }
    }

    // Optional time window: transactions without a timestamp are excluded
    // whenever a time window is configured (mirrors velocity, #19).
    if (timeStart !== undefined) {
      const timestamp = parseTimestamp(transaction.createdAt);
      if (timestamp === undefined || timestamp < timeStart || timestamp > reference) {
        continue;
      }
    }

    windowed.push(transaction);

    const sender =
      nonEmptyString(transaction.from) ?? nonEmptyString(transaction.sourceAccount);
    const recipient = nonEmptyString(transaction.to);

    if (recipient === accountId && sender !== undefined && sender !== accountId) {
      fanInTxCount += 1;
      inSenders.add(sender);
      const ledger = transaction.ledger;
      if (referenceLedger === undefined || (typeof ledger === "number" && ledger >= burstStart)) {
        inBurst.add(sender);
      }
      if (typeof ledger === "number" && Number.isFinite(ledger)) {
        addToLedgerMap(inByLedger, ledger, sender);
      }
    } else if (
      sender === accountId &&
      recipient !== undefined &&
      recipient !== accountId
    ) {
      fanOutTxCount += 1;
      outRecipients.add(recipient);
      const ledger = transaction.ledger;
      if (referenceLedger === undefined || (typeof ledger === "number" && ledger >= burstStart)) {
        outBurst.add(recipient);
      }
      if (typeof ledger === "number" && Number.isFinite(ledger)) {
        addToLedgerMap(outByLedger, ledger, recipient);
      }
    }
  }

  // Reuse the bounded counterparty graph (#20, #46) for degrees.
  const windowGraph: CounterpartyGraph = buildCounterpartyGraph(windowed, {
    maxNodes,
    maxEdges,
  });
  const fanInDegree = windowGraph.inDegree(accountId);
  const fanOutDegree = windowGraph.outDegree(accountId);

  let fanPeakInPerLedger = 0;
  for (const set of inByLedger.values()) {
    if (set.size > fanPeakInPerLedger) {
      fanPeakInPerLedger = set.size;
    }
  }
  let fanPeakOutPerLedger = 0;
  for (const set of outByLedger.values()) {
    if (set.size > fanPeakOutPerLedger) {
      fanPeakOutPerLedger = set.size;
    }
  }

  return {
    fanInDegree,
    fanOutDegree,
    fanTotalDegree: fanInDegree + fanOutDegree,
    fanInTxCount,
    fanOutTxCount,
    fanInBurstCount: inBurst.size,
    fanOutBurstCount: outBurst.size,
    fanPeakInPerLedger,
    fanPeakOutPerLedger,
    fanWindowLedgers: windowLedgers,
    fanBurstLedgers: burstLedgers,
    fanWindowMs: windowMs ?? 0,
    fanWindowTxCount: windowed.length,
    fanTruncated: windowGraph.truncated,
    fanTotalCount: transactions.length,
  };
}

/** Flattens fan-in / fan-out features into the registry's uniform map (#24). */
export function fanInOutFeaturesToFeatureMap(
  features: FanInOutFeatures
): FeatureMap {
  return {
    fanInDegree: features.fanInDegree,
    fanOutDegree: features.fanOutDegree,
    fanTotalDegree: features.fanTotalDegree,
    fanInTxCount: features.fanInTxCount,
    fanOutTxCount: features.fanOutTxCount,
    fanInBurstCount: features.fanInBurstCount,
    fanOutBurstCount: features.fanOutBurstCount,
    fanPeakInPerLedger: features.fanPeakInPerLedger,
    fanPeakOutPerLedger: features.fanPeakOutPerLedger,
    fanWindowLedgers: features.fanWindowLedgers,
    fanBurstLedgers: features.fanBurstLedgers,
    fanWindowMs: features.fanWindowMs,
    fanWindowTxCount: features.fanWindowTxCount,
    fanTruncated: features.fanTruncated,
    fanTotalCount: features.fanTotalCount,
  };
}

/** Provider options for {@link createFanInOutFeatureProvider}. */
export interface FanInOutProviderOptions extends FanInOutOptions {}

/**
 * Creates a registry-ready fan-in / fan-out provider (#37, #24).
 *
 * The scored account comes from `context.accountId` (falling back to the
 * option); history from `context.transactions` and reference time from
 * `context.now`.
 */
export function createFanInOutFeatureProvider(
  options: FanInOutProviderOptions = {}
): FeatureProvider {
  return {
    name: "fan-in-out",
    compute(context: FeatureContext): FeatureMap {
      if (!Array.isArray(context.transactions)) {
        throw new ValidationError(
          "Fan in/out features require FeatureContext.transactions (issue #13)"
        );
      }
      const features = extractFanInOutFeatures(context.transactions, {
        ...options,
        accountId: context.accountId ?? options.accountId,
        now: context.now ?? options.now,
      });
      return fanInOutFeaturesToFeatureMap(features);
    },
  };
}

export default extractFanInOutFeatures;
