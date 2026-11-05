/**
 * Memo feature extraction (issue #22).
 *
 * Memo patterns — reused memo IDs and anchor anomalies (README.md:21) —
 * are a named detection area. This module extracts memo presence, type,
 * and value from the normalized transaction history (#13) and computes
 * reuse counts, so the reused-memo-ID detector (#33) and other memo
 * detectors share one deterministic representation.
 *
 * Contract:
 * - Memo values are sanitized before use (user-controlled input):
 *   control characters, zero-width/bidi marks, and excess whitespace are
 *   stripped and values are bounded deterministically.
 * - Memo types are distinguished per Stellar's variants: `none`, `text`,
 *   `id`, `hash`, and `return`; anything else is counted as unknown.
 * - Reuse is keyed by `<type>:<value>` so a text memo and an id memo with
 *   the same bytes never count as the same memo.
 * - `id` values are normalized numerically (leading zeros collapse) so
 *   `"0012"` and `"12"` are the same reused memo. Hash/return values are
 *   compared case-insensitively. text, hash, and return values are
 *   compared exactly after sanitization.
 * - Reuse counts include every present memo, valid or not: repeated
 *   malformed memos are a signal, not something to drop.
 * - Empty or sparse histories yield zeroed features, never errors.
 */

import type { Transaction } from "../clients/horizon.js";
import { ValidationError } from "../errors.js";
import type {
  FeatureContext,
  FeatureMap,
  FeatureProvider,
} from "./types.js";

/** Stellar memo variants after normalization; "none" means no memo. */
export type MemoType = "none" | "text" | "id" | "hash" | "return" | "unknown";

/** The memo variants documented by Stellar (used for validation). */
export const MEMO_VARIANTS: readonly MemoType[] = ["text", "id", "hash", "return"] as const;

/** Default cap on a sanitized memo value's length (in characters). */
export const DEFAULT_MAX_MEMO_LENGTH = 128;

/** Control characters (C0 + C1) that must never reach logs/output. */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;
/** Zero-width and directional marks used for spoofing/invisible content. */
// eslint-disable-next-line no-misleading-character-class
const INVISIBLE_MARKS = /[\u200b-\u200f\u2028-\u202f\u2060-\u206f\ufeff\u00ad]/g;
/** Collapse runs of whitespace (already stripped of control chars). */
const WHITESPACE_RUNS = /\s+/g;

/** Options for {@link extractMemoFeatures}. */
export interface MemoFeatureOptions {
  /** Cap for sanitized memo values; defaults to {@link DEFAULT_MAX_MEMO_LENGTH}. */
  readonly maxMemoLength?: number;
}

/** One transaction's sanitized memo. */
export interface MemoEntry {
  /** Transaction id this memo came from ("" when absent). */
  readonly id: string;
  /** Normalized memo variant; "none" when no usable memo. */
  readonly type: MemoType;
  /** Sanitized memo value; "" when absent or unusable. */
  readonly value: string;
  /** Whether the transaction carried a usable memo. */
  readonly present: boolean;
  /** True when the raw value conformed to its variant's rules. */
  readonly valid: boolean;
  /** Occurrences of the same `<type>:<value>` across the given history. */
  readonly reuseCount: number;
}

/** Memo features for one account history. */
export interface MemoFeatures {
  /** Transactions considered. */
  readonly totalCount: number;
  /** Transactions carrying a usable memo. */
  readonly memoPresentCount: number;
  /** Transactions without a usable memo. */
  readonly memoAbsentCount: number;
  /** Present memos with type `text`. */
  readonly textCount: number;
  /** Present memos with type `id`. */
  readonly idCount: number;
  /** Present memos with type `hash`. */
  readonly hashCount: number;
  /** Present memos with type `return`. */
  readonly returnCount: number;
  /** Present memos with an unrecognized memoType. */
  readonly unknownTypeCount: number;
  /** Present memos whose value violated their variant's rules. */
  readonly invalidValueCount: number;
  /** Distinct `<type>:<value>` keys across present memos. */
  readonly distinctMemoCount: number;
  /** Distinct values reused at least twice. */
  readonly reusedMemoCount: number;
  /** Highest reuse of any single value. */
  readonly maxReuseCount: number;
  /** Fraction of memo-bearing transactions whose memo appears ≥ 2 times, in [0, 1]. */
  readonly reuseShare: number;
  /** Distinct `id` values reused at least twice (feeds #33). */
  readonly reusedIdMemoCount: number;
  /** Highest reuse of any single `id` value (feeds #33). */
  readonly maxIdReuseCount: number;
  /** Length (in characters) of the longest sanitized memo value. */
  readonly longestMemoLength: number;
  /** Per-transaction sanitized view, including reuse counts. */
  readonly memos: readonly MemoEntry[];
}

/**
 * Sanitizes a memo value read from an untrusted source.
 *
 * Steps: coerce to string → strip control characters, invisible/bidi
 * marks, and leading/trailing whitespace → collapse whitespace runs →
 * bound to `maxMemoLength` characters (deterministic truncation).
 *
 * @param value - Raw memo value from the transaction history.
 * @param maxMemoLength - Cap on the sanitized length; defaults to {@link DEFAULT_MAX_MEMO_LENGTH}.
 * @returns The sanitized memo; an empty string means "no usable value".
 */
export function sanitizeMemo(
  value: unknown,
  maxMemoLength: number = DEFAULT_MAX_MEMO_LENGTH
): string {
  if (!Number.isFinite(maxMemoLength) || maxMemoLength < 1) {
    throw new ValidationError("maxMemoLength must be a positive finite number");
  }
  if (value === null || value === undefined) {
    return "";
  }
  let text = String(value);
  text = text.replace(CONTROL_CHARS, "");
  text = text.replace(INVISIBLE_MARKS, "");
  text = text.replace(WHITESPACE_RUNS, " ").trim();
  return text.length > maxMemoLength ? text.slice(0, maxMemoLength) : text;
}

/** Normalizes a memo type string; empty/missing maps to "none". */
export function normalizeMemoType(memoType: unknown, hasValue: boolean): MemoType {
  if (typeof memoType !== "string") {
    return hasValue ? "unknown" : "none";
  }
  const normalized = memoType.trim().toLowerCase();
  if (normalized.length === 0) {
    return hasValue ? "unknown" : "none";
  }
  switch (normalized) {
    case "text":
    case "id":
    case "hash":
    case "return":
      return normalized;
    case "none":
      return "none";
    default:
      return "unknown";
  }
}

/**
 * Validates a sanitized memo value against its variant's rules.
 *
 * @param type - Normalized memo variant ("none" and "unknown" validate as false).
 * @param value - Sanitized memo value.
 */
export function isValidMemoValue(type: MemoType, value: string): boolean {
  switch (type) {
    case "text":
      return value.length > 0;
    case "id": {
      // Stellar MEMO_ID is a uint64; accept decimal digits in range.
      if (!/^\d{1,20}$/.test(value)) {
        return false;
      }
      try {
        return BigInt(value) <= 18446744073709551615n;
      } catch {
        return false;
      }
    }
    case "hash":
    case "return": {
      // Horizon reports hash memos as 64 hex chars or base64 (44 chars).
      const compact = value.replace(/\s+/g, "");
      return /^[0-9a-fA-F]{64}$/.test(compact) || /^[A-Za-z0-9+/]{43}={0,2}$/.test(compact);
    }
    default:
      return false;
  }
}

function canonicalValue(type: MemoType, value: string): string {
  if (type === "id") {
    if (/^\d{1,20}$/.test(value)) {
      // Collapse leading zeros; keep a single "0" for zero.
      const collapsed = value.replace(/^0+(?=\d)/, "");
      return collapsed.length > 0 ? collapsed : "0";
    }
    return value;
  }
  if (type === "hash" || type === "return") {
    return value.replace(/\s+/g, "").toLowerCase();
  }
  return value;
}

function resolveMaxMemoLength(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_MAX_MEMO_LENGTH;
  }
  if (!Number.isFinite(value) || value < 1) {
    throw new ValidationError("maxMemoLength must be a positive finite number");
  }
  return Math.trunc(value);
}

/**
 * Computes memo features from a normalized transaction history.
 *
 * @param transactions - Normalized transactions (issue #13).
 * @param options - Sanitization bounds.
 * @returns Deterministic {@link MemoFeatures}.
 * @throws {ValidationError} If `transactions` is not an array or options are invalid.
 */
export function extractMemoFeatures(
  transactions: readonly Transaction[],
  options: MemoFeatureOptions = {}
): MemoFeatures {
  if (!Array.isArray(transactions)) {
    throw new ValidationError("transactions must be an array");
  }
  const maxMemoLength = resolveMaxMemoLength(options.maxMemoLength);

  let present = 0;
  let textCount = 0;
  let idCount = 0;
  let hashCount = 0;
  let returnCount = 0;
  let unknownTypeCount = 0;
  let invalidValueCount = 0;
  let longestMemoLength = 0;

  // Keys are `<type>:<canonical value>` so types never collide.
  const keyCounts = new Map<string, number>();
  const entries: MemoEntry[] = [];

  for (const transaction of transactions) {
    if (!transaction || typeof transaction !== "object") {
      continue;
    }
    const rawValue = transaction.memo;
    const sanitized = sanitizeMemo(rawValue, maxMemoLength);
    const hasValue = sanitized.length > 0;
    const type = normalizeMemoType(transaction.memoType, hasValue);

    let value = sanitized;
    let valid = false;
    let key: string | null = null;

    if (hasValue && type !== "none" && type !== "unknown") {
      value = canonicalValue(type, sanitized);
      valid = isValidMemoValue(type, value);
      key = `${type}:${value}`;
    } else if (hasValue) {
      valid = false;
      key = `${type}:${sanitized}`;
    }

    if (key !== null) {
      keyCounts.set(key, (keyCounts.get(key) ?? 0) + 1);
    }

    entries.push({
      id: typeof transaction.id === "string" ? transaction.id : "",
      type,
      value: key === null ? "" : value,
      present: key !== null,
      valid,
      reuseCount: 0, // Filled in the second pass below.
    });

    if (key !== null) {
      present += 1;
      longestMemoLength = Math.max(longestMemoLength, value.length);
      switch (type) {
        case "text":
          textCount += 1;
          break;
        case "id":
          idCount += 1;
          break;
        case "hash":
          hashCount += 1;
          break;
        case "return":
          returnCount += 1;
          break;
        default:
          unknownTypeCount += 1;
      }
      if (!valid) {
        invalidValueCount += 1;
      }
    }
  }

  // Second pass: attach reuse counts to entries.
  const finalizedEntries: MemoEntry[] = entries.map((entry) => {
    if (!entry.present) {
      return entry;
    }
    const key = `${entry.type}:${entry.value}`;
    return { ...entry, reuseCount: keyCounts.get(key) ?? 1 };
  });

  let reusedMemoCount = 0;
  let maxReuseCount = 0;
  let reusedEntries = 0;
  let reusedIdMemoCount = 0;
  let maxIdReuseCount = 0;

  for (const [key, count] of keyCounts) {
    if (count >= 2) {
      reusedMemoCount += 1;
      maxReuseCount = Math.max(maxReuseCount, count);
      if (key.startsWith("id:")) {
        reusedIdMemoCount += 1;
        maxIdReuseCount = Math.max(maxIdReuseCount, count);
      }
    }
  }
  for (const entry of finalizedEntries) {
    if (entry.present && entry.reuseCount >= 2) {
      reusedEntries += 1;
    }
  }

  const totalCount = transactions.length;

  return {
    totalCount,
    memoPresentCount: present,
    memoAbsentCount: totalCount - present,
    textCount,
    idCount,
    hashCount,
    returnCount,
    unknownTypeCount,
    invalidValueCount,
    distinctMemoCount: keyCounts.size,
    reusedMemoCount,
    maxReuseCount,
    reuseShare: present > 0 ? reusedEntries / present : 0,
    reusedIdMemoCount,
    maxIdReuseCount,
    longestMemoLength,
    memos: finalizedEntries,
  };
}

/**
 * Flattens memo features into the registry's uniform map (#24).
 *
 * @param features - Output of {@link extractMemoFeatures}.
 * @returns Scalar feature values keyed for downstream consumers.
 */
export function memoFeaturesToFeatureMap(features: MemoFeatures): FeatureMap {
  return {
    memoTotalCount: features.totalCount,
    memoPresentCount: features.memoPresentCount,
    memoAbsentCount: features.memoAbsentCount,
    memoTextCount: features.textCount,
    memoIdCount: features.idCount,
    memoHashCount: features.hashCount,
    memoReturnCount: features.returnCount,
    memoUnknownTypeCount: features.unknownTypeCount,
    memoInvalidValueCount: features.invalidValueCount,
    memoDistinctCount: features.distinctMemoCount,
    memoReusedCount: features.reusedMemoCount,
    memoMaxReuseCount: features.maxReuseCount,
    memoReuseShare: features.reuseShare,
    memoReusedIdCount: features.reusedIdMemoCount,
    memoMaxIdReuseCount: features.maxIdReuseCount,
    memoLongestLength: features.longestMemoLength,
  };
}

/**
 * Creates a registry-ready memo provider (#22, #24).
 *
 * @param options - Defaults; every value may be overridden per call.
 */
export function createMemoFeatureProvider(
  options: MemoFeatureOptions = {}
): FeatureProvider {
  return {
    name: "memo",
    compute(context: FeatureContext): FeatureMap {
      const features = extractMemoFeatures(context.transactions, options);
      return memoFeaturesToFeatureMap(features);
    },
  };
}
