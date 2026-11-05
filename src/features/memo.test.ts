/**
 * Tests for memo feature extraction (issue #22).
 *
 * Covers sanitization (hostile input), the four Stellar memo variants
 * (text, id, hash, return), reuse-count semantics — including numeric id
 * normalization — and the registry-ready provider.
 */

import { describe, it, expect } from "vitest";
import type { Transaction } from "../clients/horizon.js";
import { ValidationError } from "../errors.js";
import {
  DEFAULT_MAX_MEMO_LENGTH,
  extractMemoFeatures,
  memoFeaturesToFeatureMap,
  createMemoFeatureProvider,
  sanitizeMemo,
  normalizeMemoType,
  isValidMemoValue,
} from "./memo.js";

const HASH_64 = "a".repeat(64);
const RETURN_64 = "b1".repeat(32);

let nextId = 0;

function makeTx(overrides: Partial<Transaction> = {}): Transaction {
  nextId += 1;
  return {
    id: `tx-${nextId}`,
    createdAt: "2026-01-01T12:00:00.000Z",
    sourceAccount: "GSOURCE",
    type: "payment",
    amount: 1,
    assetCode: "XLM",
    pagingToken: String(nextId),
    ...overrides,
  };
}

describe("sanitizeMemo", () => {
  it("strips control characters and null bytes", () => {
    expect(sanitizeMemo("a\u0000b\u0007c\u001f")).toBe("abc");
    expect(sanitizeMemo("memo\r\nline")).toBe("memoline");
    expect(sanitizeMemo("\u007fdel\u009f")).toBe("del");
  });

  it("strips invisible and bidi marks", () => {
    expect(sanitizeMemo("\u200Babc\ufeff")).toBe("abc");
    expect(sanitizeMemo("\u202Eexe\u202C")).toBe("exe");
    expect(sanitizeMemo("a\u2060b")).toBe("ab");
  });

  it("trims and collapses whitespace", () => {
    expect(sanitizeMemo("   padded   ")).toBe("padded");
    expect(sanitizeMemo("a  b   c")).toBe("a b c");
    // Tabs and newlines are C0 control characters and are removed outright.
    expect(sanitizeMemo("a\t\tb\nc")).toBe("abc");
  });

  it("bounds overlong values deterministically", () => {
    const long = "x".repeat(500);
    expect(sanitizeMemo(long)).toHaveLength(DEFAULT_MAX_MEMO_LENGTH);
    expect(sanitizeMemo(long, 8)).toBe("xxxxxxxx");
    expect(sanitizeMemo("abcdef", 10)).toBe("abcdef");
  });

  it("handles null, undefined and numbers", () => {
    expect(sanitizeMemo(null)).toBe("");
    expect(sanitizeMemo(undefined)).toBe("");
    expect(sanitizeMemo(123)).toBe("123");
  });

  it("rejects invalid maxMemoLength", () => {
    expect(() => sanitizeMemo("x", 0)).toThrow(ValidationError);
    expect(() => sanitizeMemo("x", -1)).toThrow(ValidationError);
    expect(() => sanitizeMemo("x", Number.NaN)).toThrow(ValidationError);
  });
});

describe("normalizeMemoType", () => {
  it("maps known variants case-insensitively", () => {
    expect(normalizeMemoType("TEXT", true)).toBe("text");
    expect(normalizeMemoType("id", true)).toBe("id");
    expect(normalizeMemoType("hash", true)).toBe("hash");
    expect(normalizeMemoType("return", true)).toBe("return");
  });

  it("distinguishes absent, none and unknown", () => {
    expect(normalizeMemoType(undefined, false)).toBe("none");
    expect(normalizeMemoType("none", false)).toBe("none");
    expect(normalizeMemoType("none", true)).toBe("none");
    expect(normalizeMemoType(undefined, true)).toBe("unknown");
    expect(normalizeMemoType("bogus", true)).toBe("unknown");
  });
});

describe("isValidMemoValue", () => {
  it("validates text memos", () => {
    expect(isValidMemoValue("text", "anchor deposit")).toBe(true);
    expect(isValidMemoValue("text", "")).toBe(false);
  });

  it("validates id memos as uint64 in range", () => {
    expect(isValidMemoValue("id", "0")).toBe(true);
    expect(isValidMemoValue("id", "123456789")).toBe(true);
    expect(isValidMemoValue("id", "18446744073709551615")).toBe(true);
    expect(isValidMemoValue("id", "18446744073709551616")).toBe(false);
    expect(isValidMemoValue("id", "abc")).toBe(false);
    expect(isValidMemoValue("id", "-5")).toBe(false);
  });

  it("validates hash and return memos as 64 hex or 44-char base64", () => {
    expect(isValidMemoValue("hash", HASH_64)).toBe(true);
    expect(isValidMemoValue("hash", RETURN_64)).toBe(true);
    expect(isValidMemoValue("hash", "AAAA==")).toBe(false);
    expect(isValidMemoValue("hash", "not a hash")).toBe(false);
    expect(isValidMemoValue("return", HASH_64)).toBe(true);
    expect(isValidMemoValue("none", "anything")).toBe(false);
  });
});

describe("extractMemoFeatures", () => {
  it("returns zeroed features for an empty history", () => {
    const features = extractMemoFeatures([]);

    expect(features.totalCount).toBe(0);
    expect(features.memoPresentCount).toBe(0);
    expect(features.memoAbsentCount).toBe(0);
    expect(features.distinctMemoCount).toBe(0);
    expect(features.reusedMemoCount).toBe(0);
    expect(features.maxReuseCount).toBe(0);
    expect(features.reuseShare).toBe(0);
    expect(features.reusedIdMemoCount).toBe(0);
    expect(features.maxIdReuseCount).toBe(0);
    expect(features.longestMemoLength).toBe(0);
    expect(features.memos).toEqual([]);
  });

  it("extracts presence, type, and value for text memos", () => {
    const transactions = [
      makeTx({ memo: "deposit", memoType: "text" }),
      makeTx({ memo: undefined, memoType: undefined }),
    ];
    const features = extractMemoFeatures(transactions);

    expect(features.memoPresentCount).toBe(1);
    expect(features.memoAbsentCount).toBe(1);
    expect(features.textCount).toBe(1);
    expect(features.memos[0]).toMatchObject({
      type: "text",
      value: "deposit",
      present: true,
      valid: true,
      reuseCount: 1,
    });
    expect(features.memos[1]).toMatchObject({ type: "none", present: false, reuseCount: 0 });
  });

  it("computes reuse counts across a history for text memos", () => {
    const transactions = [
      makeTx({ memo: "invoice-7", memoType: "text" }),
      makeTx({ memo: "invoice-7", memoType: "text" }),
      makeTx({ memo: "invoice-7", memoType: "text" }),
      makeTx({ memo: "other", memoType: "text" }),
    ];
    const features = extractMemoFeatures(transactions);

    expect(features.memoPresentCount).toBe(4);
    expect(features.distinctMemoCount).toBe(2);
    expect(features.reusedMemoCount).toBe(1);
    expect(features.maxReuseCount).toBe(3);
    expect(features.reuseShare).toBe(0.75);
    expect(features.longestMemoLength).toBe("invoice-7".length);
  });

  it("distinguishes the four Stellar memo variants", () => {
    const transactions = [
      makeTx({ memo: "anchor deposit", memoType: "text" }),
      makeTx({ memo: "123", memoType: "id" }),
      makeTx({ memo: HASH_64, memoType: "hash" }),
      makeTx({ memo: RETURN_64, memoType: "return" }),
    ];
    const features = extractMemoFeatures(transactions);

    expect(features.textCount).toBe(1);
    expect(features.idCount).toBe(1);
    expect(features.hashCount).toBe(1);
    expect(features.returnCount).toBe(1);
    expect(features.unknownTypeCount).toBe(0);
    expect(features.invalidValueCount).toBe(0);
    expect(features.distinctMemoCount).toBe(4);
  });

  it("normalizes id memos numerically so leading zeros collapse", () => {
    const transactions = [
      makeTx({ memo: "000123", memoType: "id" }),
      makeTx({ memo: "123", memoType: "id" }),
      makeTx({ memo: "000", memoType: "id" }),
      makeTx({ memo: "0", memoType: "id" }),
    ];
    const features = extractMemoFeatures(transactions);

    // "000123" and "123" collapse to the same key; "000" and "0" too.
    expect(features.distinctMemoCount).toBe(2);
    expect(features.maxReuseCount).toBe(2);
    expect(features.reusedIdMemoCount).toBe(2);
    expect(features.maxIdReuseCount).toBe(2);
    expect(features.idCount).toBe(4);
    expect(features.invalidValueCount).toBe(0);
  });

  it("keys hash and return memos case-insensitively but not text memos", () => {
    const transactions = [
      makeTx({ memo: HASH_64.toUpperCase(), memoType: "hash" }),
      makeTx({ memo: HASH_64, memoType: "hash" }),
      makeTx({ memo: "ABC", memoType: "text" }),
      makeTx({ memo: "abc", memoType: "text" }),
    ];
    const features = extractMemoFeatures(transactions);

    // hash pair merges (case-insensitive), text pair stays distinct.
    expect(features.distinctMemoCount).toBe(3);
    expect(features.maxReuseCount).toBe(2);
  });

  it("never merges values across memo variants", () => {
    const transactions = [
      makeTx({ memo: "123", memoType: "text" }),
      makeTx({ memo: "123", memoType: "id" }),
    ];
    const features = extractMemoFeatures(transactions);

    expect(features.distinctMemoCount).toBe(2);
    expect(features.reusedMemoCount).toBe(0);
    expect(features.reuseShare).toBe(0);
  });

  it("counts invalid values without throwing and still tracks reuse", () => {
    const transactions = [
      makeTx({ memo: "not-an-id", memoType: "id" }),
      makeTx({ memo: "not-an-id", memoType: "id" }),
      makeTx({ memo: "zzz", memoType: "hash" }),
    ];
    const features = extractMemoFeatures(transactions);

    expect(features.idCount).toBe(2);
    expect(features.hashCount).toBe(1);
    expect(features.invalidValueCount).toBe(3);
    expect(features.distinctMemoCount).toBe(2);
    expect(features.reusedMemoCount).toBe(1); // repeated malformed id is a signal
  });

  it("counts unrecognized memo types as unknown and invalid", () => {
    const transactions = [makeTx({ memo: "value", memoType: "bogus" })];
    const features = extractMemoFeatures(transactions);

    expect(features.unknownTypeCount).toBe(1);
    expect(features.invalidValueCount).toBe(1);
    expect(features.memoPresentCount).toBe(1);
    expect(features.memos[0]).toMatchObject({ type: "unknown", valid: false });
  });

  it("sanitizes memo values so hostile input cannot fake distinct memos", () => {
    const transactions = [
      makeTx({ memo: "invoice\u0000-7", memoType: "text" }),
      makeTx({ memo: "invoice-7", memoType: "text" }),
      makeTx({ memo: "\u200Binvoice-7\uFEFF", memoType: "text" }),
    ];
    const features = extractMemoFeatures(transactions);

    // All three sanitize to "invoice-7" — one distinct, heavily reused memo.
    expect(features.distinctMemoCount).toBe(1);
    expect(features.maxReuseCount).toBe(3);
  });

  it("accepts numeric memo values from fixtures", () => {
    const transactions = [
      makeTx({ memo: 123 as unknown as string, memoType: "id" }),
    ];
    const features = extractMemoFeatures(transactions);

    expect(features.idCount).toBe(1);
    expect(features.memos[0].value).toBe("123");
  });

  it("rejects invalid options", () => {
    expect(() => extractMemoFeatures([], { maxMemoLength: 0 })).toThrow(ValidationError);
    expect(() => extractMemoFeatures([], { maxMemoLength: Number.NaN })).toThrow(ValidationError);
    // @ts-expect-error - transactions must be an array at runtime
    expect(() => extractMemoFeatures(undefined)).toThrow(ValidationError);
  });
});

describe("memoFeaturesToFeatureMap", () => {
  it("flattens features into a scalar map", () => {
    const transactions = [
      makeTx({ memo: "invoice-7", memoType: "text" }),
      makeTx({ memo: "invoice-7", memoType: "text" }),
      makeTx({ memo: "42", memoType: "id" }),
    ];
    const map = memoFeaturesToFeatureMap(extractMemoFeatures(transactions));

    expect(map.memoTotalCount).toBe(3);
    expect(map.memoPresentCount).toBe(3);
    expect(map.memoTextCount).toBe(2);
    expect(map.memoIdCount).toBe(1);
    expect(map.memoMaxReuseCount).toBe(2);
    expect(map.memoMaxIdReuseCount).toBe(1);
    expect(Object.values(map).every((value) => typeof value === "number")).toBe(true);
  });
});

describe("createMemoFeatureProvider", () => {
  it("computes features from the shared context transactions", () => {
    const provider = createMemoFeatureProvider();
    const transactions = [
      makeTx({ memo: "anchor", memoType: "text" }),
      makeTx({ memo: "anchor", memoType: "text" }),
    ];

    const map = provider.compute({ transactions });

    expect(provider.name).toBe("memo");
    expect(map.memoPresentCount).toBe(2);
    expect(map.memoTextCount).toBe(2);
    expect(map.memoReusedCount).toBe(1);
  });
});
