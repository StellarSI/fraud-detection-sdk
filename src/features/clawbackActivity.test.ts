/**
 * Tests for clawback-enabled asset activity feature extraction (issue #36).
 *
 * Acceptance criteria: clawback-enabled assets are identified; clawback
 * operations and unusual volume/frequency are surfaced; windows and
 * thresholds are configurable; normal (non-clawback) activity stays quiet;
 * the registry-ready provider produces the same flat feature map.
 */

import { describe, it, expect } from "vitest";
import type { Account, AccountBalance, Transaction } from "../clients/horizon.js";
import { ValidationError } from "../errors.js";
import {
  DEFAULT_CLAWBACK_ACTIVITY_WINDOW_MS,
  DEFAULT_CLAWBACK_ACTIVITY_BURST_WINDOW_MS,
  CLAWBACK_OPERATION_TYPES,
  isClawbackOperation,
  extractClawbackActivityFeatures,
  clawbackActivityFeaturesToFeatureMap,
  createClawbackActivityFeatureProvider,
} from "./clawbackActivity.js";

const ACCOUNT = "GACCOUNT00000000000000000000000000000000000000000000000000";
const OTHER = "GOTHER00000000000000000000000000000000000000000000000000000";
const ISSUER = "GISSUER0000000000000000000000000000000000000000000000000000";
const REFERENCE = "2026-01-01T12:00:00.000Z";
const REFERENCE_MS = Date.parse(REFERENCE);
const HOUR_MS = 60 * 60 * 1000;

function makeBalance(overrides: Partial<AccountBalance> = {}): AccountBalance {
  return {
    code: "XLM",
    type: "native",
    amount: 1000,
    clawbackEnabled: false,
    authorized: true,
    ...overrides,
  };
}

function makeAccount(
  balances: AccountBalance[],
  overrides: Partial<Account> = {}
): Account {
  return {
    id: ACCOUNT,
    sequence: 1,
    sequenceString: "1",
    signatureThreshold: 0,
    subentryCount: balances.length,
    thresholds: { low: 0, medium: 0, high: 0 },
    balances,
    signers: [],
    data: {},
    lastLedger: 1,
    pagingToken: "1",
    ...overrides,
  };
}

function tx(overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: "tx-1",
    createdAt: REFERENCE,
    sourceAccount: OTHER,
    type: "payment",
    amount: 100,
    assetCode: "XLM",
    from: OTHER,
    to: ACCOUNT,
    pagingToken: "1",
    ...overrides,
  };
}

function clawbackAccount(): Account {
  return makeAccount([
    makeBalance(),
    makeBalance({
      code: "USD",
      issuer: ISSUER,
      type: "credit_alphanum4",
      amount: 500,
      clawbackEnabled: true,
    }),
  ]);
}

const options = { now: REFERENCE, accountId: ACCOUNT };

describe("isClawbackOperation", () => {
  it("recognizes every clawback operation type", () => {
    for (const type of CLAWBACK_OPERATION_TYPES) {
      expect(isClawbackOperation(tx({ type }))).toBe(true);
    }
    expect(isClawbackOperation(tx({ type: "PAYMENT" }))).toBe(false);
    expect(isClawbackOperation(tx({ type: "clawback" }))).toBe(true);
  });
});

describe("extractClawbackActivityFeatures - identification", () => {
  it("identifies clawback-enabled assets from account balances", () => {
    const features = extractClawbackActivityFeatures(
      clawbackAccount(),
      [],
      options
    );
    expect(features.clawbackEnabledAssetCount).toBe(1);
  });

  it("identifies explicit clawback assets and matches bare codes", () => {
    const account = makeAccount([makeBalance()]);
    const transactions = [
      tx({ id: "a", assetCode: "USD", assetIssuer: ISSUER, amount: 10 }),
      tx({ id: "b", assetCode: "EUR", assetIssuer: OTHER, amount: 20 }),
    ];
    const features = extractClawbackActivityFeatures(account, transactions, {
      ...options,
      clawbackAssets: ["USD:" + ISSUER],
    });
    expect(features.clawbackEnabledAssetCount).toBe(1);
    expect(features.clawbackTransactionCount).toBe(1);
    expect(features.clawbackTotalVolume).toBe(10);

    const byCode = extractClawbackActivityFeatures(account, transactions, {
      ...options,
      clawbackAssets: ["eur"],
    });
    expect(byCode.clawbackTransactionCount).toBe(1);
    expect(byCode.clawbackTotalVolume).toBe(20);
  });

  it("yields zeroed features for normal accounts with no clawback assets", () => {
    const account = makeAccount([makeBalance()]);
    const transactions = [
      tx({ id: "a", amount: 100 }),
      tx({ id: "b", type: "path_payment_strict_send", amount: 200 }),
    ];
    const features = extractClawbackActivityFeatures(account, transactions, options);
    expect(features.clawbackEnabledAssetCount).toBe(0);
    expect(features.clawbackTransactionCount).toBe(0);
    expect(features.clawbackOperationCount).toBe(0);
    expect(features.clawbackBurstCount).toBe(0);
    expect(features.clawbackTotalVolume).toBe(0);
  });
});

describe("extractClawbackActivityFeatures - operations, volume, burst", () => {
  it("counts clawback operations even without a matching balance", () => {
    const account = makeAccount([makeBalance()]);
    const transactions = [
      tx({ id: "op-1", type: "clawback", assetCode: "XYZ", assetIssuer: OTHER }),
      tx({ id: "op-2", type: "clawback_claimable_balance" }),
    ];
    const features = extractClawbackActivityFeatures(account, transactions, options);
    expect(features.clawbackOperationCount).toBe(2);
    expect(features.clawbackBurstCount).toBe(2);
    expect(features.clawbackBurstDetected).toBe(true);
  });

  it("tracks volume, max, mean, direction and distinct assets", () => {
    const transactions = [
      tx({ id: "a", assetCode: "USD", assetIssuer: ISSUER, amount: 100 }),
      tx({
        id: "b",
        assetCode: "USD",
        assetIssuer: ISSUER,
        amount: 300,
        from: ACCOUNT,
        to: OTHER,
        sourceAccount: ACCOUNT,
      }),
      tx({ id: "c", assetCode: "USD", assetIssuer: ISSUER, amount: 200 }),
    ];
    const features = extractClawbackActivityFeatures(
      clawbackAccount(),
      transactions,
      options
    );
    expect(features.clawbackTransactionCount).toBe(3);
    expect(features.clawbackTotalVolume).toBe(600);
    expect(features.clawbackMaxAmount).toBe(300);
    expect(features.clawbackMeanAmount).toBe(200);
    expect(features.clawbackDistinctAssetCount).toBe(1);
    expect(features.clawbackInboundCount).toBe(2);
    expect(features.clawbackOutboundCount).toBe(1);
  });

  it("measures the maximum number of events in a sliding burst window", () => {
    const transactions = [
      tx({ id: "1", createdAt: new Date(REFERENCE_MS - 5 * HOUR_MS).toISOString(), type: "clawback" }),
      tx({ id: "2", createdAt: new Date(REFERENCE_MS - 4 * HOUR_MS).toISOString(), type: "clawback" }),
      tx({ id: "3", createdAt: new Date(REFERENCE_MS - 10 * 60_000).toISOString(), type: "clawback" }),
      tx({ id: "4", createdAt: new Date(REFERENCE_MS - 5 * 60_000).toISOString(), type: "clawback" }),
    ];
    const features = extractClawbackActivityFeatures(
      makeAccount([makeBalance()]),
      transactions,
      { ...options, burstWindowMs: HOUR_MS, burstThreshold: 3 }
    );
    expect(features.clawbackBurstCount).toBe(2);
    expect(features.clawbackBurstDetected).toBe(false);

    const sensitive = extractClawbackActivityFeatures(
      makeAccount([makeBalance()]),
      transactions,
      { ...options, burstWindowMs: HOUR_MS, burstThreshold: 2 }
    );
    expect(sensitive.clawbackBurstDetected).toBe(true);
  });
});

describe("extractClawbackActivityFeatures - configuration", () => {
  it("honors a configurable recent window", () => {
    const transactions = [
      tx({ id: "recent", type: "clawback", createdAt: REFERENCE }),
      tx({
        id: "old",
        type: "clawback",
        createdAt: new Date(REFERENCE_MS - 3 * DEFAULT_CLAWBACK_ACTIVITY_WINDOW_MS).toISOString(),
      }),
    ];
    const account = makeAccount([makeBalance()]);
    const all = extractClawbackActivityFeatures(account, transactions, options);
    expect(all.clawbackOperationCount).toBe(1);

    const wide = extractClawbackActivityFeatures(account, transactions, {
      ...options,
      windowMs: 4 * DEFAULT_CLAWBACK_ACTIVITY_WINDOW_MS,
    });
    expect(wide.clawbackOperationCount).toBe(2);
    expect(wide.clawbackWindowMs).toBe(4 * DEFAULT_CLAWBACK_ACTIVITY_WINDOW_MS);
    expect(DEFAULT_CLAWBACK_ACTIVITY_BURST_WINDOW_MS).toBe(HOUR_MS);
  });

  it("rejects invalid options", () => {
    const account = makeAccount([makeBalance()]);
    expect(() =>
      extractClawbackActivityFeatures(account, [], { ...options, windowMs: 0 })
    ).toThrow(ValidationError);
    expect(() =>
      extractClawbackActivityFeatures(account, [], { ...options, burstThreshold: -1 })
    ).toThrow(ValidationError);
    expect(() =>
      extractClawbackActivityFeatures(account, [], { ...options, clawbackAssets: [""] })
    ).toThrow(ValidationError);
  });
});

describe("clawbackActivityFeaturesToFeatureMap + provider", () => {
  it("flattens features into a scalar FeatureMap", () => {
    const features = extractClawbackActivityFeatures(
      clawbackAccount(),
      [tx({ assetCode: "USD", assetIssuer: ISSUER, amount: 50 })],
      options
    );
    const map = clawbackActivityFeaturesToFeatureMap(features);
    expect(map.clawbackEnabledAssetCount).toBe(1);
    expect(map.clawbackTransactionCount).toBe(1);
    expect(map.clawbackTotalVolume).toBe(50);
    expect(map.clawbackBurstDetected).toBe(false);
    expect(map.clawbackWindowMs).toBe(DEFAULT_CLAWBACK_ACTIVITY_WINDOW_MS);
  });

  it("computes the same map through the registry-ready provider", () => {
    const account = clawbackAccount();
    const transactions = [tx({ assetCode: "USD", assetIssuer: ISSUER, amount: 50 })];
    const provider = createClawbackActivityFeatureProvider({ accountId: ACCOUNT });
    const map = provider.compute({ account, transactions, now: REFERENCE, accountId: ACCOUNT });
    const direct = clawbackActivityFeaturesToFeatureMap(
      extractClawbackActivityFeatures(account, transactions, options)
    );
    expect(map).toEqual(direct);
    expect(provider.name).toBe("clawback-activity");
  });

  it("requires an account and transaction array", () => {
    const provider = createClawbackActivityFeatureProvider();
    expect(() => provider.compute({ transactions: [] })).toThrow(ValidationError);
    expect(() =>
      provider.compute({ account: makeAccount([makeBalance()]), transactions: undefined as never })
    ).toThrow(ValidationError);
  });
});
