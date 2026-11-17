/**
 * Tests for rapid fan-in / fan-out feature extraction (issue #37).
 *
 * Acceptance criteria: fan-in and fan-out are distinguished; bursts inside
 * a small ledger window are surfaced; window and thresholds are
 * configurable; steady activity stays quiet; the registry-ready provider
 * produces the same flat feature map.
 */

import { describe, it, expect } from "vitest";
import type { Transaction } from "../clients/horizon.js";
import { ValidationError } from "../errors.js";
import {
  DEFAULT_FAN_WINDOW_LEDGERS,
  DEFAULT_FAN_BURST_LEDGERS,
  extractFanInOutFeatures,
  fanInOutFeaturesToFeatureMap,
  createFanInOutFeatureProvider,
} from "./fanInOut.js";

const ACCOUNT = "GACCOUNT00000000000000000000000000000000000000000000000000";
const REFERENCE = "2026-01-01T12:00:00.000Z";
const options = { accountId: ACCOUNT, now: REFERENCE };

function tx(overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: "tx-1",
    createdAt: REFERENCE,
    sourceAccount: ACCOUNT,
    type: "payment",
    amount: 10,
    assetCode: "XLM",
    from: ACCOUNT,
    to: ACCOUNT,
    ledger: 100,
    pagingToken: "1",
    ...overrides,
  };
}

function inbound(from: string, ledger: number, id: string): Transaction {
  return tx({ id, from, to: ACCOUNT, sourceAccount: from, ledger });
}

function outbound(to: string, ledger: number, id: string): Transaction {
  return tx({ id, from: ACCOUNT, to, sourceAccount: ACCOUNT, ledger });
}

describe("extractFanInOutFeatures - direction", () => {
  it("distinguishes fan-in from fan-out", () => {
    const transactions = [
      inbound("SENDER1", 100, "in-1"),
      inbound("SENDER2", 101, "in-2"),
      inbound("SENDER3", 102, "in-3"),
      outbound("RECIP1", 100, "out-1"),
      outbound("RECIP2", 101, "out-2"),
      outbound("RECIP3", 101, "out-3"),
      outbound("RECIP4", 102, "out-4"),
    ];
    const features = extractFanInOutFeatures(transactions, options);
    expect(features.fanInDegree).toBe(3);
    expect(features.fanOutDegree).toBe(4);
    expect(features.fanTotalDegree).toBe(7);
    expect(features.fanInTxCount).toBe(3);
    expect(features.fanOutTxCount).toBe(4);
  });

  it("reports burst counts and per-ledger peaks", () => {
    const transactions = [
      inbound("SENDER1", 100, "in-1"),
      inbound("SENDER2", 100, "in-2"),
      inbound("SENDER3", 101, "in-3"),
      inbound("SENDER4", 101, "in-4"),
      inbound("SENDER5", 102, "in-5"),
    ];
    const features = extractFanInOutFeatures(transactions, options);
    expect(features.fanInBurstCount).toBe(5);
    expect(features.fanOutBurstCount).toBe(0);
    expect(features.fanPeakInPerLedger).toBe(2);
    expect(features.fanBurstLedgers).toBe(DEFAULT_FAN_BURST_LEDGERS);
  });

  it("ignores self-transfers and unrelated transactions", () => {
    const transactions = [
      tx({ id: "self", from: ACCOUNT, to: ACCOUNT, ledger: 100 }),
      tx({ id: "unrelated", from: "SENDER1", to: "RECIP1", ledger: 100 }),
    ];
    const features = extractFanInOutFeatures(transactions, options);
    expect(features.fanTotalDegree).toBe(0);
    expect(features.fanInTxCount).toBe(0);
    expect(features.fanOutTxCount).toBe(0);
  });
});

describe("extractFanInOutFeatures - windowing and configuration", () => {
  it("uses a configurable ledger window", () => {
    const transactions = [
      inbound("OLD", 90, "old"),
      inbound("SENDER1", 99, "in-1"),
      inbound("SENDER2", 100, "in-2"),
    ];
    const narrow = extractFanInOutFeatures(transactions, {
      ...options,
      referenceLedger: 100,
      windowLedgers: 2,
    });
    expect(narrow.fanInDegree).toBe(2);
    expect(narrow.fanWindowLedgers).toBe(2);

    const wide = extractFanInOutFeatures(transactions, {
      ...options,
      referenceLedger: 100,
      windowLedgers: 20,
    });
    expect(wide.fanInDegree).toBe(3);
    expect(DEFAULT_FAN_WINDOW_LEDGERS).toBe(10);
  });

  it("uses a configurable burst window", () => {
    const transactions = [
      inbound("S1", 100, "in-1"),
      inbound("S2", 101, "in-2"),
      inbound("S3", 102, "in-3"),
    ];
    const small = extractFanInOutFeatures(transactions, {
      ...options,
      referenceLedger: 102,
      burstLedgers: 2,
    });
    expect(small.fanInBurstCount).toBe(2);

    const large = extractFanInOutFeatures(transactions, {
      ...options,
      referenceLedger: 102,
      burstLedgers: 3,
    });
    expect(large.fanInBurstCount).toBe(3);
  });

  it("combines an optional time window", () => {
    const transactions = [
      inbound("RECENT", 100, "recent"),
      inbound(
        "OLD",
        100,
        "old",
      ),
    ];
    transactions[1] = {
      ...transactions[1]!,
      createdAt: new Date(Date.parse(REFERENCE) - 3 * 60 * 60 * 1000).toISOString(),
    };
    const features = extractFanInOutFeatures(transactions, {
      ...options,
      windowMs: 60 * 60 * 1000,
    });
    expect(features.fanInDegree).toBe(1);
    expect(features.fanWindowMs).toBe(60 * 60 * 1000);
  });

  it("stays quiet for steady activity spread across many ledgers", () => {
    const transactions: Transaction[] = [];
    for (let ledger = 1; ledger <= 40; ledger += 1) {
      transactions.push(inbound(ledger % 2 === 0 ? "S1" : "S2", ledger, `in-${ledger}`));
    }
    const features = extractFanInOutFeatures(transactions, {
      ...options,
      referenceLedger: 40,
      windowLedgers: 10,
      burstLedgers: 3,
    });
    expect(features.fanInDegree).toBe(2);
    expect(features.fanInBurstCount).toBe(2);
    expect(features.fanPeakInPerLedger).toBe(1);
  });

  it("reports graph truncation when bounds are exceeded", () => {
    const transactions = [
      inbound("S1", 100, "1"),
      inbound("S2", 100, "2"),
      inbound("S3", 100, "3"),
      inbound("S4", 100, "4"),
    ];
    const features = extractFanInOutFeatures(transactions, {
      ...options,
      maxNodes: 2,
      maxEdges: 2,
    });
    expect(features.fanTruncated).toBe(true);
  });

  it("rejects invalid options", () => {
    expect(() => extractFanInOutFeatures([], {})).toThrow(ValidationError);
    expect(() =>
      extractFanInOutFeatures([], { ...options, windowLedgers: 0 })
    ).toThrow(ValidationError);
    expect(() =>
      extractFanInOutFeatures([], { ...options, burstLedgers: 1.5 })
    ).toThrow(ValidationError);
    expect(() =>
      extractFanInOutFeatures([], { ...options, windowMs: -1 })
    ).toThrow(ValidationError);
    expect(() =>
      extractFanInOutFeatures([], { ...options, referenceLedger: -1 })
    ).toThrow(ValidationError);
  });
});

describe("fanInOutFeaturesToFeatureMap + provider", () => {
  it("flattens features into a scalar FeatureMap", () => {
    const features = extractFanInOutFeatures(
      [inbound("S1", 100, "a"), outbound("R1", 100, "b")],
      options
    );
    const map = fanInOutFeaturesToFeatureMap(features);
    expect(map.fanInDegree).toBe(1);
    expect(map.fanOutDegree).toBe(1);
    expect(map.fanTotalDegree).toBe(2);
    expect(map.fanWindowLedgers).toBe(DEFAULT_FAN_WINDOW_LEDGERS);
  });

  it("computes the same map through the registry-ready provider", () => {
    const transactions = [inbound("S1", 100, "a"), inbound("S2", 100, "b")];
    const provider = createFanInOutFeatureProvider({ accountId: ACCOUNT });
    const map = provider.compute({ transactions, now: REFERENCE, accountId: ACCOUNT });
    const direct = fanInOutFeaturesToFeatureMap(
      extractFanInOutFeatures(transactions, options)
    );
    expect(map).toEqual(direct);
    expect(provider.name).toBe("fan-in-out");
  });

  it("requires a transaction array", () => {
    const provider = createFanInOutFeatureProvider({ accountId: ACCOUNT });
    expect(() =>
      provider.compute({ transactions: undefined as never, accountId: ACCOUNT })
    ).toThrow(ValidationError);
  });
});
