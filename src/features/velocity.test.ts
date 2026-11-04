/**
 * Tests for velocity feature extraction (issue #19).
 *
 * Covers empty, sparse, and dense histories, custom windows, boundary
 * behavior, malformed timestamps, and the registry-ready provider.
 */

import { describe, it, expect } from "vitest";
import type { Transaction } from "../clients/horizon.js";
import { ValidationError } from "../errors.js";
import {
  DEFAULT_VELOCITY_WINDOWS,
  createVelocityFeatureProvider,
  extractVelocityFeatures,
} from "./velocity.js";

const REFERENCE = "2026-01-01T12:00:00.000Z";
const REFERENCE_MS = Date.parse(REFERENCE);
const ACCOUNT = "GACCOUNT";
const PARTY_A = "GPARTYA";
const PARTY_B = "GPARTYB";
const PARTY_C = "GPARTYC";

function minutesAgo(minutes: number): string {
  return new Date(REFERENCE_MS - minutes * 60_000).toISOString();
}

let nextId = 0;

function makeTx(overrides: Partial<Transaction> = {}): Transaction {
  nextId += 1;
  return {
    id: `tx-${nextId}`,
    createdAt: REFERENCE,
    sourceAccount: ACCOUNT,
    type: "payment",
    amount: 1,
    assetCode: "XLM",
    pagingToken: String(nextId),
    ...overrides,
  };
}

describe("extractVelocityFeatures", () => {
  it("returns zeroed features for an empty history", () => {
    const features = extractVelocityFeatures([], { now: REFERENCE });

    expect(features).toMatchObject({
      txCount1h: 0,
      txCount24h: 0,
      txPerLedger: 0,
      uniqueCounterparties24h: 0,
      totalCount: 0,
      uniqueLedgers: 0,
      windowCounts: { "1h": 0, "24h": 0 },
      referenceTime: REFERENCE,
    });
    expect(features.windows).toEqual(DEFAULT_VELOCITY_WINDOWS);
  });

  it("computes counts for a sparse history", () => {
    const transactions = [
      makeTx({ createdAt: minutesAgo(30), ledger: 10, to: PARTY_A }),
      makeTx({ createdAt: minutesAgo(180), ledger: 11, from: PARTY_B }),
      makeTx({ createdAt: minutesAgo(30 * 60), ledger: 12, to: PARTY_C }),
    ];

    const features = extractVelocityFeatures(transactions, {
      now: REFERENCE,
      accountId: ACCOUNT,
    });

    expect(features.txCount1h).toBe(1);
    expect(features.txCount24h).toBe(2);
    expect(features.uniqueCounterparties24h).toBe(2);
    expect(features.txPerLedger).toBe(1);
    expect(features.totalCount).toBe(3);
  });

  it("computes counts for a dense history and deduplicates counterparties", () => {
    const recent = Array.from({ length: 25 }, (_, index) =>
      makeTx({
        createdAt: minutesAgo(1 + index * 0.25),
        ledger: index % 2 === 0 ? 100 : 101,
        to: index % 2 === 0 ? PARTY_A : PARTY_B,
      })
    );
    const older = Array.from({ length: 5 }, (_, index) =>
      makeTx({ createdAt: minutesAgo(2 * 24 * 60 + index), ledger: 99, to: PARTY_C })
    );

    const features = extractVelocityFeatures([...recent, ...older], {
      now: REFERENCE,
      accountId: ACCOUNT,
    });

    expect(features.txCount1h).toBe(25);
    expect(features.txCount24h).toBe(25);
    expect(features.uniqueCounterparties24h).toBe(2);
    expect(features.uniqueLedgers).toBe(3);
    expect(features.txPerLedger).toBe(10);
  });

  it("supports configurable window sizes and names", () => {
    const transactions = [
      makeTx({ createdAt: minutesAgo(10), ledger: 1, to: PARTY_A }),
      makeTx({ createdAt: minutesAgo(120), ledger: 2, to: PARTY_B }),
      makeTx({ createdAt: minutesAgo(3 * 24 * 60), ledger: 3, to: PARTY_C }),
    ];

    const features = extractVelocityFeatures(transactions, {
      now: REFERENCE,
      windows: [
        { name: "15m", durationMs: 15 * 60_000 },
        { name: "7d", durationMs: 7 * 24 * 60 * 60_000 },
      ],
    });

    expect(features.windowCounts).toEqual({ "15m": 1, "7d": 3 });
    // The fixed convenience fields are zero when those windows are absent.
    expect(features.txCount1h).toBe(0);
    expect(features.txCount24h).toBe(0);
    // The 24h counterparty feature keeps its fixed 24h semantics.
    expect(features.uniqueCounterparties24h).toBe(2);
  });

  it("includes transactions exactly on the window start boundary", () => {
    const transactions = [
      makeTx({ createdAt: minutesAgo(60) }),
      makeTx({ createdAt: new Date(REFERENCE_MS - 60 * 60_000 - 1).toISOString() }),
    ];

    const features = extractVelocityFeatures(transactions, {
      now: REFERENCE,
      windows: [{ name: "1h", durationMs: 60 * 60_000 }],
    });

    expect(features.windowCounts["1h"]).toBe(1);
  });

  it("ignores future transactions for windows but keeps them in totals", () => {
    const transactions = [
      makeTx({ createdAt: new Date(REFERENCE_MS + 60 * 60_000).toISOString(), ledger: 7 }),
    ];

    const features = extractVelocityFeatures(transactions, { now: REFERENCE });

    expect(features.txCount1h).toBe(0);
    expect(features.txCount24h).toBe(0);
    expect(features.totalCount).toBe(1);
    expect(features.uniqueLedgers).toBe(1);
  });

  it("skips unparseable timestamps rather than throwing", () => {
    const transactions = [
      makeTx({ createdAt: "", ledger: 1 }),
      makeTx({ createdAt: "not-a-date", ledger: 1 }),
      makeTx({ createdAt: minutesAgo(5), ledger: 2 }),
    ];

    const features = extractVelocityFeatures(transactions, { now: REFERENCE });

    expect(features.totalCount).toBe(3);
    expect(features.txCount1h).toBe(1);
    expect(features.txPerLedger).toBeCloseTo(1.5);
  });

  it("excludes the scored account from counterparties", () => {
    const transactions = [
      makeTx({ createdAt: minutesAgo(5), to: ACCOUNT }),
      makeTx({ createdAt: minutesAgo(6), from: ACCOUNT }),
      makeTx({ createdAt: minutesAgo(7), to: PARTY_A }),
    ];

    const features = extractVelocityFeatures(transactions, {
      now: REFERENCE,
      accountId: ACCOUNT,
    });

    expect(features.uniqueCounterparties24h).toBe(1);
  });

  it("defaults the reference time to now without failing on empty input", () => {
    const features = extractVelocityFeatures([]);
    expect(Number.isNaN(Date.parse(features.referenceTime))).toBe(false);
  });

  it("rejects invalid window configuration", () => {
    expect(() =>
      extractVelocityFeatures([], { now: REFERENCE, windows: [] })
    ).toThrow(ValidationError);

    expect(() =>
      extractVelocityFeatures([], {
        now: REFERENCE,
        windows: [{ name: "bad", durationMs: 0 }],
      })
    ).toThrow(ValidationError);

    expect(() =>
      extractVelocityFeatures([], {
        now: REFERENCE,
        windows: [
          { name: "dup", durationMs: 1 },
          { name: "dup", durationMs: 2 },
        ],
      })
    ).toThrow(ValidationError);
  });

  it("rejects an invalid reference time", () => {
    expect(() => extractVelocityFeatures([], { now: "not-a-date" })).toThrow(
      ValidationError
    );
  });
});

describe("createVelocityFeatureProvider", () => {
  it("returns a registry-ready provider named velocity", () => {
    const provider = createVelocityFeatureProvider();
    expect(provider.name).toBe("velocity");

    const map = provider.compute({
      accountId: ACCOUNT,
      now: REFERENCE,
      transactions: [
        makeTx({ createdAt: minutesAgo(5), ledger: 1, to: PARTY_A }),
      ],
    });

    expect(map).toMatchObject({
      txCount1h: 1,
      txCount24h: 1,
      uniqueCounterparties24h: 1,
      velocityTotalCount: 1,
      "txCount_1h": 1,
      "txCount_24h": 1,
    });
  });
});
