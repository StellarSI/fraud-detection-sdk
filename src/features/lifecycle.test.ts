/**
 * Tests for lifecycle feature extraction (issue #23).
 *
 * Covers young vs. old accounts, accounts funded via `create_account`
 * (both directions), rapid vs. settled merge activity, the registry
 * provider, and the validation errors for missing context.
 */

import { describe, it, expect } from "vitest";
import type { Account, Transaction } from "../clients/horizon.js";
import { ValidationError } from "../errors.js";
import {
  DEFAULT_RAPID_MERGE_WINDOW_MS,
  extractLifecycleFeatures,
  lifecycleFeaturesToFeatureMap,
  createLifecycleFeatureProvider,
} from "./lifecycle.js";

const ACCOUNT = "GABCDEFGHIJKLMNOPQRSTUVWXYZABCDEFGHIJKLMNOPQRSTUVWXYZABCDEF";
const OTHER = "GZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ";
const DAY_MS = 24 * 60 * 60 * 1000;
const REFERENCE = "2026-01-10T00:00:00.000Z";
const REFERENCE_MS = Date.parse(REFERENCE);
const isoDaysAgo = (days: number): string =>
  new Date(REFERENCE_MS - days * DAY_MS).toISOString();

function tx(overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: `tx-${Math.random().toString(36).slice(2)}`,
    createdAt: REFERENCE,
    sourceAccount: ACCOUNT,
    type: "payment",
    amount: 1,
    ledger: 100,
    pagingToken: "1",
    ...overrides,
  };
}

function makeAccount(id: string = ACCOUNT): Account {
  return {
    id,
    sequence: 1,
    sequenceString: "1",
    signatureThreshold: 2,
    subentryCount: 0,
    thresholds: { low: 0, medium: 2, high: 2 },
    balances: [
      {
        code: "XLM",
        type: "native",
        amount: 100,
        clawbackEnabled: false,
        authorized: true,
      },
    ],
    signers: [],
    data: {},
    lastLedger: 120,
    pagingToken: "1",
  };
}

describe("account age", () => {
  it("computes age from the funding create_account when present (young account)", () => {
    const features = extractLifecycleFeatures(
      [
        tx({
          id: "ca-1",
          type: "create_account",
          createdAt: isoDaysAgo(2),
          sourceAccount: OTHER,
          from: OTHER,
          to: ACCOUNT,
          ledger: 100,
        }),
        tx({ id: "p-1", ledger: 120 }),
      ],
      { accountId: ACCOUNT, now: REFERENCE }
    );

    expect(features.ageMs).toBe(2 * DAY_MS);
    expect(features.ageLedgers).toBe(20); // latestLedgerSeen (120) - createdLedger (100)
    expect(features.firstSeenLedger).toBe(100);
    expect(features.latestLedgerSeen).toBe(120);
    expect(features.accountCreatedLedger).toBe(100);
    expect(features.accountCreatedAt).toBe(isoDaysAgo(2));
    expect(features.accountCreatedInHistory).toBe(true);
    expect(features.referenceTime).toBe(REFERENCE);
  });

  it("treats much older histories as old even without a creation tx", () => {
    const features = extractLifecycleFeatures(
      [
        tx({ id: "p-old", createdAt: isoDaysAgo(400), ledger: 50 }),
        tx({ id: "p-new", createdAt: isoDaysAgo(300), ledger: 90 }),
      ],
      { accountId: ACCOUNT, now: REFERENCE }
    );

    expect(features.ageMs).toBeGreaterThan(300 * DAY_MS);
    expect(features.ageLedgers).toBe(40); // span of the observed history
    expect(features.accountCreatedInHistory).toBe(false);
    expect(features.accountCreatedLedger).toBeNull();
  });

  it("yields zeroed features for an empty history", () => {
    const features = extractLifecycleFeatures([], {
      accountId: ACCOUNT,
      now: REFERENCE,
    });

    expect(features.ageMs).toBe(0);
    expect(features.ageLedgers).toBe(0);
    expect(features.totalCount).toBe(0);
    expect(features.rapidMergeFlag).toBe(false);
    expect(features.msToFirstMerge).toBeNull();
  });
});

describe("create_account funding", () => {
  it("counts funding this account performed, with distinct recipients", () => {
    const features = extractLifecycleFeatures(
      [
        tx({ id: "ca-1", type: "create_account", from: ACCOUNT, to: "T1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", sourceAccount: ACCOUNT }),
        tx({ id: "ca-2", type: "create_account", from: ACCOUNT, to: "T2BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB", sourceAccount: ACCOUNT }),
        tx({ id: "ca-3", type: "create_account", from: ACCOUNT, to: "T1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", sourceAccount: ACCOUNT }), // repeat recipient
      ],
      { accountId: ACCOUNT, now: REFERENCE }
    );

    expect(features.createAccountCount).toBe(3);
    expect(features.fundedAccountsCount).toBe(2);
  });

  it("detects this account being funded at creation (funding source)", () => {
    const features = extractLifecycleFeatures(
      [tx({ id: "ca-1", type: "create_account", sourceAccount: OTHER, from: OTHER, to: ACCOUNT })],
      { accountId: ACCOUNT, now: REFERENCE }
    );

    expect(features.accountFundedByCount).toBe(1);
    expect(features.accountCreatedInHistory).toBe(true);
    expect(features.createAccountCount).toBe(0);
  });

  it("keeps the earliest creation funding when several are present", () => {
    const features = extractLifecycleFeatures(
      [
        tx({ id: "ca-new", type: "create_account", sourceAccount: OTHER, from: OTHER, to: ACCOUNT, createdAt: isoDaysAgo(2), ledger: 110 }),
        tx({ id: "ca-old", type: "create_account", sourceAccount: OTHER, from: OTHER, to: ACCOUNT, createdAt: isoDaysAgo(9), ledger: 60 }),
      ],
      { accountId: ACCOUNT, now: REFERENCE }
    );

    expect(features.accountCreatedLedger).toBe(60);
    expect(features.accountCreatedAt).toBe(isoDaysAgo(9));
    expect(features.accountFundedByCount).toBe(2);
  });

  it("normalizes operation type spellings", () => {
    const features = extractLifecycleFeatures(
      [
        tx({ id: "ca-1", type: "create-account", sourceAccount: OTHER, from: OTHER, to: ACCOUNT }),
        tx({ id: "mg-1", type: "account-merge", sourceAccount: ACCOUNT }),
      ],
      { accountId: ACCOUNT, now: REFERENCE }
    );

    expect(features.accountFundedByCount).toBe(1);
    expect(features.mergeCount).toBe(1);
  });
});

describe("account merges", () => {
  it("flags rapid merge activity after creation", () => {
    const created = isoDaysAgo(3);
    const merged = new Date(Date.parse(created) + 2 * DAY_MS).toISOString();
    const features = extractLifecycleFeatures(
      [
        tx({ id: "ca-1", type: "create_account", sourceAccount: OTHER, from: OTHER, to: ACCOUNT, createdAt: created, ledger: 100 }),
        tx({ id: "mg-1", type: "account_merge", sourceAccount: ACCOUNT, createdAt: merged, ledger: 105 }),
      ],
      { accountId: ACCOUNT, now: REFERENCE }
    );

    expect(features.mergeCount).toBe(1);
    expect(features.msToFirstMerge).toBe(2 * DAY_MS);
    expect(features.rapidMergeFlag).toBe(true);
    expect(features.mergesPerDay).toBeCloseTo(1 / 3, 6);
  });

  it("does not flag merges long after creation", () => {
    const features = extractLifecycleFeatures(
      [
        tx({ id: "ca-1", type: "create_account", sourceAccount: OTHER, from: OTHER, to: ACCOUNT, createdAt: isoDaysAgo(120), ledger: 10 }),
        tx({ id: "mg-1", type: "account_merge", sourceAccount: ACCOUNT, createdAt: isoDaysAgo(10), ledger: 130 }),
      ],
      { accountId: ACCOUNT, now: REFERENCE }
    );

    expect(features.mergeCount).toBe(1);
    expect(features.msToFirstMerge).toBe(110 * DAY_MS);
    expect(features.rapidMergeFlag).toBe(false);
  });

  it("ignores merges performed by other accounts", () => {
    const features = extractLifecycleFeatures(
      [tx({ id: "mg-1", type: "account_merge", sourceAccount: OTHER, createdAt: isoDaysAgo(1) })],
      { accountId: ACCOUNT, now: REFERENCE }
    );

    expect(features.mergeCount).toBe(0);
    expect(features.rapidMergeFlag).toBe(false);
  });

  it("respects a custom rapid-merge window", () => {
    const created = isoDaysAgo(30);
    const merged = new Date(Date.parse(created) + 20 * DAY_MS).toISOString();
    const features = extractLifecycleFeatures(
      [
        tx({ id: "ca-1", type: "create_account", sourceAccount: OTHER, from: OTHER, to: ACCOUNT, createdAt: created }),
        tx({ id: "mg-1", type: "account_merge", sourceAccount: ACCOUNT, createdAt: merged }),
      ],
      { accountId: ACCOUNT, now: REFERENCE, rapidMergeWindowMs: 30 * DAY_MS }
    );

    expect(features.rapidMergeFlag).toBe(true);
    expect(features.rapidMergeWindowMs).toBe(30 * DAY_MS);
  });
});

describe("lifecycleFeaturesToFeatureMap and provider", () => {
  it("flattens to a model-friendly map", () => {
    const features = extractLifecycleFeatures(
      [tx({ id: "mg-1", type: "account_merge", sourceAccount: ACCOUNT, createdAt: isoDaysAgo(1) })],
      { accountId: ACCOUNT, now: REFERENCE }
    );
    const map = lifecycleFeaturesToFeatureMap(features);

    expect(map.accountMergeCount).toBe(1);
    expect(map.accountAgeMs).toBe(DAY_MS);
    expect(map.lifecycleTransactionCount).toBe(1);
    expect(typeof map.rapidMergeFlag).toBe("boolean");
  });

  it("provider requires the scored account", () => {
    const provider = createLifecycleFeatureProvider();
    expect(() =>
      provider.compute({ transactions: [], now: REFERENCE })
    ).toThrow(ValidationError);
  });

  it("provider falls back to context.account.id", () => {
    const provider = createLifecycleFeatureProvider();
    const map = provider.compute({
      transactions: [
        tx({ id: "mg-1", type: "account_merge", sourceAccount: ACCOUNT, createdAt: isoDaysAgo(1) }),
      ],
      account: makeAccount(),
      now: REFERENCE,
    });

    expect(map.accountMergeCount).toBe(1);
  });

  it("context.accountId wins over options", () => {
    const provider = createLifecycleFeatureProvider({ accountId: OTHER });
    const map = provider.compute({
      transactions: [
        tx({ id: "mg-1", type: "account_merge", sourceAccount: ACCOUNT, createdAt: isoDaysAgo(1) }),
      ],
      accountId: ACCOUNT,
      now: REFERENCE,
    });

    expect(map.accountMergeCount).toBe(1);
  });
});

describe("validation", () => {
  it("rejects non-array transactions", () => {
    expect(() =>
      extractLifecycleFeatures(null as never, { accountId: ACCOUNT })
    ).toThrow(ValidationError);
  });

  it("rejects a missing account id", () => {
    expect(() => extractLifecycleFeatures([], {})).toThrow(ValidationError);
    expect(() =>
      extractLifecycleFeatures([], { accountId: "   " })
    ).toThrow(ValidationError);
  });

  it("rejects an invalid reference time and rapid-merge window", () => {
    expect(() =>
      extractLifecycleFeatures([], { accountId: ACCOUNT, now: "not-a-date" })
    ).toThrow(ValidationError);
    expect(() =>
      extractLifecycleFeatures([], { accountId: ACCOUNT, rapidMergeWindowMs: 0 })
    ).toThrow(ValidationError);
    expect(() =>
      extractLifecycleFeatures([], { accountId: ACCOUNT, rapidMergeWindowMs: Number.NaN })
    ).toThrow(ValidationError);
  });

  it("exports the default rapid-merge window", () => {
    expect(DEFAULT_RAPID_MERGE_WINDOW_MS).toBe(7 * DAY_MS);
  });
});
