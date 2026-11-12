/**
 * Tests for claimable-balance feature extraction (issues #31, #32).
 *
 * Covers parsing of `create_claimable_balance` / `claim_claimable_balance`
 * operations, claimant attribution, staleness matching of claims by
 * balance id, unrelated-claimant analysis, window/burst math, and the
 * airdrop context signals the rules rely on.
 */

import { describe, it, expect } from "vitest";
import type { Transaction } from "../clients/horizon.js";
import { ValidationError } from "../errors.js";
import {
  extractClaimableBalanceFeatures,
  claimableBalanceFeaturesToFeatureMap,
  createClaimableBalanceFeatureProvider,
  DEFAULT_CLAIMABLE_BALANCE_UNCLAIMED_AGE_MS,
} from "./claimableBalances.js";

const ACCOUNT =
  "GACCOUNT00000000000000000000000000000000000000000000000000";
const NOW = Date.parse("2026-06-01T00:00:00.000Z");

let nextId = 0;
function makeTx(overrides: Partial<Transaction> = {}): Transaction {
  nextId += 1;
  return {
    id: `tx-${nextId}`,
    createdAt: "2026-05-01T00:00:00.000Z",
    sourceAccount: ACCOUNT,
    type: "payment",
    amount: 1,
    from: ACCOUNT,
    to: "GOTHER00000000000000000000000000000000000000000000000",
    pagingToken: String(nextId),
    ...overrides,
  };
}

function createClaimable(
  claimants: string[],
  overrides: Partial<Transaction> = {}
): Transaction {
  return makeTx({
    type: "create_claimable_balance",
    from: ACCOUNT,
    sourceAccount: ACCOUNT,
    amount: 1,
    to: claimants.length === 1 ? claimants[0] : undefined,
    claimants,
    createdAt: "2026-05-20T00:00:00.000Z",
    ...overrides,
  });
}

function claimClaimable(balanceId: string | undefined, overrides: Partial<Transaction> = {}): Transaction {
  return makeTx({
    type: "claim_claimable_balance",
    from: "GCLAIMER0000000000000000000000000000000000000000000000000",
    sourceAccount: "GCLAIMER0000000000000000000000000000000000000000000000000",
    balanceId,
    amount: 1,
    ...overrides,
  });
}

describe("extractClaimableBalanceFeatures - parsing and attribution", () => {
  it("counts created balances and distinct claimants from `claimants` arrays", () => {
    const features = extractClaimableBalanceFeatures(
      [
        createClaimable(["GCLM1", "GCLM2"], { amount: 5, balanceId: "b1" }),
        createClaimable(["GCLM2", "GCLM3"], { amount: 5, balanceId: "b2" }),
      ],
      { accountId: ACCOUNT, now: NOW }
    );

    expect(features.createdCount).toBe(2);
    expect(features.claimantsCount).toBe(3);
    expect(features.totalVolume).toBe(10);
    expect(features.averageAmount).toBe(5);
  });

  it("falls back to `to` when no claimants array is present", () => {
    const features = extractClaimableBalanceFeatures(
      [createClaimable([], { to: "GTOONLY0000000000000000000000000000000000000000000000000" })],
      { accountId: ACCOUNT, now: NOW }
    );

    expect(features.createdCount).toBe(1);
    expect(features.claimantsCount).toBe(1);
  });

  it("ignores create_claimable_balance operations created by other accounts", () => {
    const other = "GOTHER00000000000000000000000000000000000000000000000000000";
    const features = extractClaimableBalanceFeatures(
      [
        createClaimable(["GCLM1"], {
          from: other,
          sourceAccount: other,
          balanceId: "b-other",
        }),
      ],
      { accountId: ACCOUNT, now: NOW }
    );

    expect(features.createdCount).toBe(0);
    expect(features.claimantsCount).toBe(0);
  });

  it("sees the flat claimant ids produced by normalization", () => {
    const tx = makeTx({
      type: "create_claimable_balance",
      from: ACCOUNT,
      sourceAccount: ACCOUNT,
      claimants: ["GOBJ1", "GOBJ2"],
      balanceId: "b-obj",
      createdAt: "2026-05-20T00:00:00.000Z",
    });
    const features = extractClaimableBalanceFeatures([tx], {
      accountId: ACCOUNT,
      now: NOW,
    });
    expect(features.claimantsCount).toBe(2);
  });
});

describe("extractClaimableBalanceFeatures - unclaimed detection", () => {
  it("flags balances older than the staleness threshold with no observed claim", () => {
    const features = extractClaimableBalanceFeatures(
      [
        createClaimable(["GCLM1"], {
          balanceId: "b-stale",
          createdAt: "2026-04-01T00:00:00.000Z",
        }),
        createClaimable(["GCLM2"], {
          balanceId: "b-fresh",
          createdAt: "2026-05-31T00:00:00.000Z",
        }),
      ],
      { accountId: ACCOUNT, now: NOW }
    );

    expect(features.unclaimedCount).toBe(1);
    expect(features.oldestUnclaimedAgeMs).toBeGreaterThan(
      DEFAULT_CLAIMABLE_BALANCE_UNCLAIMED_AGE_MS
    );
    expect(features.unclaimedRatio).toBeCloseTo(0.5, 5);
  });

  it("does not flag created balances whose claim was observed", () => {
    const features = extractClaimableBalanceFeatures(
      [
        createClaimable(["GCLM1"], {
          balanceId: "b-claimed",
          createdAt: "2026-04-01T00:00:00.000Z",
        }),
        claimClaimable("b-claimed", {
          createdAt: "2026-04-02T00:00:00.000Z",
        }),
      ],
      { accountId: ACCOUNT, now: NOW }
    );

    expect(features.claimObservedCount).toBe(1);
    expect(features.unclaimedCount).toBe(0);
    expect(features.unclaimedRatio).toBe(0);
  });

  it("cannot age entries without timestamps, so they are not counted as unclaimed", () => {
    const features = extractClaimableBalanceFeatures(
      [createClaimable(["GCLM1"], { balanceId: "b-no-ts", createdAt: "" })],
      { accountId: ACCOUNT, now: NOW }
    );

    expect(features.createdCount).toBe(1);
    expect(features.unclaimedCount).toBe(0);
  });
});

describe("extractClaimableBalanceFeatures - spam context", () => {
  it("counts claimants with no other history activity as unrelated", () => {
    const features = extractClaimableBalanceFeatures(
      [
        createClaimable(["GUNREL1", "GUNREL2", "GRELATED"], {
          balanceId: "b-spam",
          createdAt: "2026-05-20T00:00:00.000Z",
        }),
        // GRELATED shows up in an ordinary payment, so it is related.
        makeTx({
          type: "payment",
          from: ACCOUNT,
          to: "GRELATED",
          createdAt: "2026-05-21T00:00:00.000Z",
        }),
      ],
      { accountId: ACCOUNT, now: NOW }
    );

    expect(features.unrelatedClaimants).toBe(2);
    expect(features.unrelatedRatio).toBeCloseTo(2 / 3, 5);
  });

  it("detects uniform-amount, single-asset airdrop context", () => {
    const features = extractClaimableBalanceFeatures(
      [
        createClaimable(["GCLM1"], { amount: 10, assetCode: "USDC", assetIssuer: "GISS", balanceId: "a1" }),
        createClaimable(["GCLM2"], { amount: 10, assetCode: "USDC", assetIssuer: "GISS", balanceId: "a2" }),
      ],
      { accountId: ACCOUNT, now: NOW }
    );

    expect(features.assetDiversity).toBe(1);
    expect(features.uniformAmount).toBe(true);
    expect(features.airdropMemoDetected).toBe(false);
  });

  it("detects the airdrop memo marker", () => {
    const features = extractClaimableBalanceFeatures(
      [
        createClaimable(["GCLM1"], {
          memo: "Q3 airdrop for holders",
          assetCode: "USDC",
          assetIssuer: "GISS",
          balanceId: "m1",
        }),
      ],
      { accountId: ACCOUNT, now: NOW }
    );

    expect(features.airdropMemoDetected).toBe(true);
  });

  it("detects mixed assets and mixed amounts as non-airdrop context", () => {
    const features = extractClaimableBalanceFeatures(
      [
        createClaimable(["GCLM1"], { amount: 1, assetCode: "USDC", assetIssuer: "GISS", balanceId: "x1" }),
        createClaimable(["GCLM2"], { amount: 7, assetCode: "XLM", balanceId: "x2" }),
      ],
      { accountId: ACCOUNT, now: NOW }
    );

    expect(features.assetDiversity).toBe(2);
    expect(features.uniformAmount).toBe(false);
  });
});

describe("extractClaimableBalanceFeatures - window and burst math", () => {
  it("counts creations and claimants inside the recent window", () => {
    const features = extractClaimableBalanceFeatures(
      [
        createClaimable(["GCLM1"], {
          balanceId: "w1",
          createdAt: "2026-05-31T12:00:00.000Z",
        }),
        createClaimable(["GCLM2"], {
          balanceId: "w2",
          createdAt: "2026-04-01T00:00:00.000Z",
        }),
      ],
      { accountId: ACCOUNT, now: NOW, windowMs: 24 * 60 * 60 * 1000 }
    );

    expect(features.createdCountInWindow).toBe(1);
    expect(features.claimantsCountInWindow).toBe(1);
  });

  it("detects a burst of creations inside the burst window", () => {
    const txs = Array.from({ length: 6 }, (_, i) =>
      createClaimable([`GCLM${i}`], {
        balanceId: `burst-${i}`,
        createdAt: `2026-05-31T00:0${i}:00.000Z`,
      })
    );
    const features = extractClaimableBalanceFeatures(txs, {
      accountId: ACCOUNT,
      now: NOW,
      burstThreshold: 5,
      burstWindowMs: 60 * 60 * 1000,
    });

    expect(features.burstCount).toBe(6);
    expect(features.burstDetected).toBe(true);
  });
});

describe("extractClaimableBalanceFeatures - edge cases", () => {
  it("yields zeroed features for an empty history", () => {
    const features = extractClaimableBalanceFeatures([], {
      accountId: ACCOUNT,
      now: NOW,
    });

    expect(features.createdCount).toBe(0);
    expect(features.claimantsCount).toBe(0);
    expect(features.unclaimedCount).toBe(0);
    expect(features.abuseScore).toBe(0);
    expect(features.spamScore).toBe(0);
  });

  it("requires the scored accountId", () => {
    expect(() => extractClaimableBalanceFeatures([])).toThrow(ValidationError);
  });

  it("rejects an invalid `now`", () => {
    expect(() =>
      extractClaimableBalanceFeatures([], {
        accountId: ACCOUNT,
        now: "not-a-date",
      })
    ).toThrow();
  });
});

describe("claimableBalanceFeaturesToFeatureMap", () => {
  it("flattens features into the uniform map", () => {
    const features = extractClaimableBalanceFeatures(
      [createClaimable(["GCLM1"], { balanceId: "f1" })],
      { accountId: ACCOUNT, now: NOW }
    );
    const map = claimableBalanceFeaturesToFeatureMap(features);

    expect(map["claimableBalanceCreatedCount"]).toBe(1);
    expect(map["claimableBalanceClaimantsCount"]).toBe(1);
    expect(map["unsolicitedClaimSpamDistinctClaimants"]).toBe(1);
    expect(typeof map["claimableBalanceAbuseScore"]).toBe("number");
    expect(typeof map["unsolicitedClaimSpamScore"]).toBe("number");
  });
});

describe("createClaimableBalanceFeatureProvider", () => {
  it("computes a feature map from a shared context", () => {
    const provider = createClaimableBalanceFeatureProvider();
    expect(provider.name).toBe("claimableBalances");
    const map = provider.compute({
      accountId: ACCOUNT,
      transactions: [createClaimable(["GCLM1"], { balanceId: "p1" })],
      now: NOW,
    });

    expect(map["claimableBalanceCreatedCount"]).toBe(1);
  });
});
