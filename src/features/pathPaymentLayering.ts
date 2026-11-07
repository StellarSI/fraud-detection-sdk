/**
 * Path-payment layering feature extraction (issue #26).
 *
 * Path payments can obscure asset origin or layer value through multiple
 * hops (README.md). This module parses `path_payment_strict_send` and
 * `path_payment_strict_receive` operations, summarizes hop chains,
 * detects circular path patterns, and measures rapid successive path
 * payments so the path-payment layering rule can emit scaled signals.
 *
 * Data sources:
 * - Transaction `type` (or operation type) identifies path payments.
 * - `path` (intermediate assets) provides hop-chain length when present
 *   on operation-enriched records. When absent, the payment is still
 *   counted as a path payment with 0 known intermediate hops.
 * - Graph cycle detection (#46 via CounterpartyGraph helpers) is used to
 *   flag circular counterparty flows among path-payment transactions.
 */

import type { Transaction } from "../clients/horizon.js";
import { ValidationError } from "../errors.js";
import { CounterpartyGraph } from "./graph.js";
import type {
  FeatureContext,
  FeatureMap,
  FeatureProvider,
} from "./types.js";

/** Operation types that indicate a Stellar path payment. */
export const PATH_PAYMENT_TYPES = new Set([
  "path_payment_strict_send",
  "path_payment_strict_receive",
]);

/** Default window for "rapid successive" path payments. */
export const DEFAULT_RAPID_PATH_PAYMENT_WINDOW_MS = 60 * 60 * 1000; // 1 hour

/** Default minimum intermediate hops to treat a chain as long. */
export const DEFAULT_LONG_CHAIN_HOPS = 2;

/** Options for {@link extractPathPaymentLayeringFeatures}. */
export interface PathPaymentLayeringOptions {
  /** Reference time for recency/frequency windows. Defaults to now. */
  readonly now?: Date | string | number;
  /** Window for rapid successive path payments. Default: 1 hour. */
  readonly rapidWindowMs?: number;
  /** Intermediate hop threshold for long chains. Default: 2. */
  readonly longChainHops?: number;
}

/** Per-account path-payment layering features. */
export interface PathPaymentLayeringFeatures {
  /** Path payment operations identified in the history. */
  readonly pathPaymentCount: number;
  /** Maximum intermediate hop count observed on a path payment. */
  readonly maxHopCount: number;
  /** Path payments with a long intermediate hop chain. */
  readonly longChainCount: number;
  /** Path payments whose intermediate path revisits an asset/cycle marker. */
  readonly circularPathCount: number;
  /** Path payments occurring within the rapid window relative to another. */
  readonly rapidSuccessiveCount: number;
  /** Whether path-payment counterparty flow contains a directed cycle. */
  readonly hasCircularFlow: boolean;
  /** Severity in [0, 1] scaled by hop count and frequency. */
  readonly layeringScore: number;
}

function resolveNow(value: Date | string | number | undefined): number {
  if (value === undefined) {
    return Date.now();
  }
  if (value instanceof Date) {
    const ms = value.getTime();
    if (!Number.isFinite(ms)) {
      throw new ValidationError("now must be a valid date");
    }
    return ms;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new ValidationError("now must be a finite timestamp");
    }
    return value;
  }
  if (typeof value === "string") {
    const ms = Date.parse(value);
    if (!Number.isFinite(ms)) {
      throw new ValidationError("now must be a parseable date string");
    }
    return ms;
  }
  throw new ValidationError("now must be a Date, timestamp, or ISO string");
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

type PathAsset = { asset_type?: string; asset_code?: string; asset_issuer?: string };

function assetKey(asset: PathAsset | string | null | undefined): string {
  if (!asset) {
    return "native";
  }
  if (typeof asset === "string") {
    return asset || "native";
  }
  if (asset.asset_type === "native" || (!asset.asset_code && !asset.asset_issuer)) {
    return "native";
  }
  return `${asset.asset_code ?? ""}:${asset.asset_issuer ?? ""}`;
}

/**
 * Returns true when the transaction represents a path payment operation.
 * Accepts `type` and duck-typed `operationType`/`operation_type`.
 */
export function isPathPaymentTransaction(
  transaction: Transaction & { operationType?: string; operation_type?: string }
): boolean {
  const type =
    transaction.type ??
    transaction.operationType ??
    transaction.operation_type ??
    "";
  return PATH_PAYMENT_TYPES.has(type);
}

/** Returns the intermediate hop count for a path payment. */
export function getPathHopCount(
  transaction: Transaction & { path?: unknown }
): number {
  const path = transaction.path;
  if (!Array.isArray(path)) {
    return 0;
  }
  return path.length;
}

/** Returns true when the intermediate path revisits an asset (circular hop chain). */
export function hasCircularPath(
  transaction: Transaction & { path?: unknown }
): boolean {
  const path = transaction.path;
  if (!Array.isArray(path) || path.length < 2) {
    return false;
  }
  const seen = new Set<string>();
  for (const hop of path as Array<PathAsset | string>) {
    const key = assetKey(hop);
    if (seen.has(key)) {
      return true;
    }
    seen.add(key);
  }
  return false;
}

function txTimeMs(transaction: Transaction): number | null {
  if (!transaction.createdAt) {
    return null;
  }
  const ms = Date.parse(transaction.createdAt);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Extracts path-payment layering features from normalized transactions.
 *
 * @param transactions - Normalized transaction history.
 * @param options - Time/frequency and long-chain thresholds.
 */
export function extractPathPaymentLayeringFeatures(
  transactions: readonly Transaction[],
  options: PathPaymentLayeringOptions = {}
): PathPaymentLayeringFeatures {
  if (!Array.isArray(transactions)) {
    throw new ValidationError("transactions must be an array");
  }

  const nowMs = resolveNow(options.now);
  const rapidWindowMs =
    options.rapidWindowMs ?? DEFAULT_RAPID_PATH_PAYMENT_WINDOW_MS;
  if (!Number.isFinite(rapidWindowMs) || rapidWindowMs <= 0) {
    throw new ValidationError("rapidWindowMs must be a positive finite number");
  }
  const longChainHops = options.longChainHops ?? DEFAULT_LONG_CHAIN_HOPS;
  if (!Number.isFinite(longChainHops) || longChainHops < 0) {
    throw new ValidationError("longChainHops must be a non-negative finite number");
  }

  const pathPayments: Array<Transaction & { _time: number | null }> = [];
  const flowGraph = new CounterpartyGraph();

  for (const transaction of transactions) {
    if (!transaction || typeof transaction !== "object") {
      continue;
    }
    if (!isPathPaymentTransaction(transaction as Transaction)) {
      continue;
    }
    pathPayments.push({ ...transaction, _time: txTimeMs(transaction) });
    const from = transaction.from ?? transaction.sourceAccount;
    const to = transaction.to;
    if (
      typeof from === "string" &&
      from.length > 0 &&
      typeof to === "string" &&
      to.length > 0
    ) {
      flowGraph.addEdge(from, to);
    }
  }

  let maxHopCount = 0;
  let longChainCount = 0;
  let circularPathCount = 0;

  for (const tx of pathPayments) {
    const hops = getPathHopCount(tx);
    if (hops > maxHopCount) {
      maxHopCount = hops;
    }
    if (hops >= longChainHops) {
      longChainCount += 1;
    }
    if (hasCircularPath(tx)) {
      circularPathCount += 1;
    }
  }

  // Rapid successive: path payments with another path payment in the window.
  // Count each qualifying payment (frequency signal).
  let rapidSuccessiveCount = 0;
  const times = pathPayments
    .map((tx) => tx._time)
    .filter((t): t is number => t !== null)
    .sort((a, b) => a - b);
  if (times.length >= 2) {
    for (let i = 0; i < times.length; i += 1) {
      const t = times[i];
      let rapid = false;
      for (let j = 0; j < times.length; j += 1) {
        if (i === j) continue;
        const delta = Math.abs(t - times[j]);
        if (delta <= rapidWindowMs && delta >= 0) {
          // Favor recent activity relative to now when timestamps span history.
          if (nowMs - t <= rapidWindowMs * 24 || nowMs - times[j] <= rapidWindowMs * 24) {
            rapid = true;
            break;
          }
          rapid = true;
          break;
        }
      }
      if (rapid) {
        rapidSuccessiveCount += 1;
      }
    }
  }

  const hasCircularFlow = flowGraph.hasDirectedCycle();

  // Severity scales with hop count and frequency. Normalize to [0,1].
  const hopFactor = pathPayments.length === 0 ? 0 : Math.min(maxHopCount / 5, 1);
  const freqFactor =
    pathPayments.length === 0
      ? 0
      : Math.min(pathPayments.length / 10 + rapidSuccessiveCount / 10, 1);
  const circularFactor =
    circularPathCount > 0 || hasCircularFlow
      ? Math.min(0.35 + (circularPathCount + (hasCircularFlow ? 1 : 0)) * 0.15, 1)
      : 0;
  const longFactor =
    pathPayments.length === 0 ? 0 : Math.min(longChainCount / Math.max(pathPayments.length, 1), 1);
  const layeringScore = clamp01(
    hopFactor * 0.35 + freqFactor * 0.3 + circularFactor * 0.25 + longFactor * 0.1
  );

  return {
    pathPaymentCount: pathPayments.length,
    maxHopCount,
    longChainCount,
    circularPathCount,
    rapidSuccessiveCount,
    hasCircularFlow,
    layeringScore,
  };
}

/**
 * Flattens path-payment layering features into the registry's uniform map (#24).
 */
export function pathPaymentLayeringFeaturesToFeatureMap(
  features: PathPaymentLayeringFeatures
): FeatureMap {
  return {
    pathPaymentCount: features.pathPaymentCount,
    pathPaymentMaxHops: features.maxHopCount,
    pathPaymentLongChainCount: features.longChainCount,
    pathPaymentCircularCount: features.circularPathCount,
    pathPaymentRapidCount: features.rapidSuccessiveCount,
    pathPaymentHasCircularFlow: features.hasCircularFlow,
    pathPaymentLayeringScore: features.layeringScore,
  };
}

/** Options for {@link createPathPaymentLayeringFeatureProvider}. */
export interface PathPaymentLayeringProviderOptions
  extends PathPaymentLayeringOptions {}

/**
 * Creates a registry-ready path-payment layering provider (#24, #26).
 */
export function createPathPaymentLayeringFeatureProvider(
  options: PathPaymentLayeringProviderOptions = {}
): FeatureProvider {
  return {
    name: "pathPaymentLayering",
    compute(context: FeatureContext): FeatureMap {
      return pathPaymentLayeringFeaturesToFeatureMap(
        extractPathPaymentLayeringFeatures(context.transactions, {
          ...options,
          now: options.now ?? context.now,
        })
      );
    },
  };
}
