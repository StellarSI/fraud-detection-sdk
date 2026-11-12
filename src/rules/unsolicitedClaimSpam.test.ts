/**
 * Tests for the unsolicited claim-spam detector rule (issue #32).
 *
 * Acceptance criteria: mass unsolicited claims emit a signal;
 * legitimate airdrops can be distinguished; thresholds are configurable;
 * and cases cover spam, airdrop, and normal scenarios.
 */

import { describe, it, expect } from "vitest";
import type { Transaction } from "../clients/horizon.js";
import { RuleEngine, createRuleEngine } from "./engine.js";
import {
  DEFAULT_UNSOLICITED_CLAIM_SPAM_RULE_WEIGHT,
  createUnsolicitedClaimSpamRule,
} from "./unsolicitedClaimSpam.js";
import {
  extractClaimableBalanceFeatures,
  claimableBalanceFeaturesToFeatureMap,
} from "../features/claimableBalances.js";

const ACCOUNT =
  "GACCOUNT00000000000000000000000000000000000000000000000000";
const NOW = Date.parse("2026-06-01T00:00:00.000Z");

function ruleContext(overrides: Record<string, number | boolean> = {}) {
  return {
    unsolicitedClaimSpamDistinctClaimants: 0,
    unsolicitedClaimSpamUnrelatedClaimants: 0,
    unsolicitedClaimSpamUnrelatedRatio: 0,
    unsolicitedClaimSpamScore: 0,
    claimableBalanceCreatedCount: 0,
    claimableBalanceClaimantsCount: 0,
    claimableBalanceBurstCount: 0,
    claimableBalanceAssetDiversity: 0,
    claimableBalanceTotalVolume: 0,
    claimableBalanceUniformAmount: false,
    claimableBalanceAirdropMemo: false,
    ...overrides,
  };
}

let nextId = 0;
function createClaimable(
  claimants: string[],
  overrides: Partial<Transaction> = {}
): Transaction {
  nextId += 1;
  return {
    id: `spam-${nextId}`,
    createdAt: "2026-05-20T00:00:00.000Z",
    sourceAccount: ACCOUNT,
    type: "create_claimable_balance",
    amount: 0.5,
    from: ACCOUNT,
    claimants,
    pagingToken: String(nextId),
    ...overrides,
  };
}

describe("createUnsolicitedClaimSpamRule - spam case", () => {
  it("emits a signal for mass claims to many unrelated accounts", () => {
    const rule = createUnsolicitedClaimSpamRule();
    const signal = rule.evaluate(
      ruleContext({
        unsolicitedClaimSpamDistinctClaimants: 12,
        unsolicitedClaimSpamUnrelatedClaimants: 11,
        unsolicitedClaimSpamUnrelatedRatio: 11 / 12,
        unsolicitedClaimSpamScore: 0.8,
        claimableBalanceCreatedCount: 12,
        claimableBalanceClaimantsCount: 12,
        claimableBalanceAssetDiversity: 3,
        claimableBalanceTotalVolume: 150,
        claimableBalanceUniformAmount: false,
      })
    );

    expect(signal).not.toBeNull();
    expect(signal?.id).toBe("unsolicited-claim-spam");
    expect(signal?.weight).toBeGreaterThan(0);
    expect(signal?.detail ?? "").toMatch(/claimant/i);
    expect(signal?.detail ?? "").toMatch(/no prior relationship/i);
  });

  it("scales weight with distinct claimant count", () => {
    const rule = createUnsolicitedClaimSpamRule({
      recipientCountThreshold: 5,
      airdropMaxAssetDiversity: 0,
    });
    const mild = rule.evaluate(
      ruleContext({
        unsolicitedClaimSpamDistinctClaimants: 5,
        unsolicitedClaimSpamUnrelatedClaimants: 5,
        unsolicitedClaimSpamUnrelatedRatio: 1,
        claimableBalanceCreatedCount: 5,
        claimableBalanceAssetDiversity: 2,
      })
    );
    const severe = rule.evaluate(
      ruleContext({
        unsolicitedClaimSpamDistinctClaimants: 20,
        unsolicitedClaimSpamUnrelatedClaimants: 19,
        unsolicitedClaimSpamUnrelatedRatio: 0.95,
        claimableBalanceCreatedCount: 20,
        claimableBalanceAssetDiversity: 4,
      })
    );

    expect(mild).not.toBeNull();
    expect(severe).not.toBeNull();
    expect(severe?.weight ?? 0).toBeGreaterThan(mild?.weight ?? 0);
  });
});

describe("createUnsolicitedClaimSpamRule - legitimate airdrop case", () => {
  it("distinguishes a single-asset uniform-amount airdrop from spam", () => {
    const rule = createUnsolicitedClaimSpamRule();
    const signal = rule.evaluate(
      ruleContext({
        unsolicitedClaimSpamDistinctClaimants: 25,
        unsolicitedClaimSpamUnrelatedClaimants: 25,
        unsolicitedClaimSpamUnrelatedRatio: 1,
        unsolicitedClaimSpamScore: 0.1,
        claimableBalanceCreatedCount: 25,
        claimableBalanceClaimantsCount: 25,
        claimableBalanceAssetDiversity: 1,
        claimableBalanceTotalVolume: 250,
        claimableBalanceUniformAmount: true,
      })
    );

    expect(signal).toBeNull();
  });

  it("flags a single-asset distribution when amounts are not uniform", () => {
    const rule = createUnsolicitedClaimSpamRule();
    const signal = rule.evaluate(
      ruleContext({
        unsolicitedClaimSpamDistinctClaimants: 25,
        unsolicitedClaimSpamUnrelatedClaimants: 25,
        unsolicitedClaimSpamUnrelatedRatio: 1,
        unsolicitedClaimSpamScore: 0.7,
        claimableBalanceCreatedCount: 25,
        claimableBalanceAssetDiversity: 1,
        claimableBalanceTotalVolume: 900,
        claimableBalanceUniformAmount: false,
      })
    );

    expect(signal).not.toBeNull();
    expect(signal?.id).toBe("unsolicited-claim-spam");
  });

  it("honors a required airdrop memo marker when configured", () => {
    const rule = createUnsolicitedClaimSpamRule({
      airdropRequireMemoMarker: true,
    });
    const withoutMemo = rule.evaluate(
      ruleContext({
        unsolicitedClaimSpamDistinctClaimants: 25,
        unsolicitedClaimSpamUnrelatedClaimants: 25,
        unsolicitedClaimSpamUnrelatedRatio: 1,
        unsolicitedClaimSpamScore: 0.8,
        claimableBalanceAssetDiversity: 1,
        claimableBalanceUniformAmount: true,
        claimableBalanceAirdropMemo: false,
      })
    );
    const withMemo = rule.evaluate(
      ruleContext({
        unsolicitedClaimSpamDistinctClaimants: 25,
        unsolicitedClaimSpamUnrelatedClaimants: 25,
        unsolicitedClaimSpamUnrelatedRatio: 1,
        unsolicitedClaimSpamScore: 0.8,
        claimableBalanceAssetDiversity: 1,
        claimableBalanceUniformAmount: true,
        claimableBalanceAirdropMemo: true,
      })
    );

    expect(withoutMemo).not.toBeNull();
    expect(withMemo).toBeNull();
  });

  it("honors airdropMaxAssetDiversity = 0 as a disable switch", () => {
    const rule = createUnsolicitedClaimSpamRule({ airdropMaxAssetDiversity: 0 });
    const signal = rule.evaluate(
      ruleContext({
        unsolicitedClaimSpamDistinctClaimants: 25,
        unsolicitedClaimSpamUnrelatedClaimants: 25,
        unsolicitedClaimSpamUnrelatedRatio: 1,
        unsolicitedClaimSpamScore: 0.8,
        claimableBalanceAssetDiversity: 1,
        claimableBalanceUniformAmount: true,
      })
    );

    expect(signal).not.toBeNull();
  });
});

describe("createUnsolicitedClaimSpamRule - normal case", () => {
  it("emits no signal below the recipient threshold", () => {
    const rule = createUnsolicitedClaimSpamRule();
    expect(
      rule.evaluate(
        ruleContext({
          unsolicitedClaimSpamDistinctClaimants: 2,
          unsolicitedClaimSpamUnrelatedClaimants: 2,
          unsolicitedClaimSpamUnrelatedRatio: 1,
          unsolicitedClaimSpamScore: 0.5,
          claimableBalanceCreatedCount: 2,
        })
      )
    ).toBeNull();
  });

  it("emits no signal when there is no claimable-balance activity", () => {
    const rule = createUnsolicitedClaimSpamRule();
    expect(rule.evaluate(ruleContext())).toBeNull();
    expect(rule.evaluate({})).toBeNull();
  });
});

describe("createUnsolicitedClaimSpamRule - configurable thresholds", () => {
  it("honors a custom recipientCountThreshold", () => {
    const context = ruleContext({
      unsolicitedClaimSpamDistinctClaimants: 3,
      unsolicitedClaimSpamUnrelatedClaimants: 3,
      unsolicitedClaimSpamUnrelatedRatio: 1,
      unsolicitedClaimSpamScore: 0.5,
      claimableBalanceAssetDiversity: 2,
      claimableBalanceCreatedCount: 3,
    });

    expect(
      createUnsolicitedClaimSpamRule({
        recipientCountThreshold: 3,
        airdropMaxAssetDiversity: 0,
      }).evaluate(context)
    ).not.toBeNull();
    expect(
      createUnsolicitedClaimSpamRule({ recipientCountThreshold: 5 }).evaluate(context)
    ).toBeNull();
  });

  it("rejects invalid numeric options", () => {
    expect(
      () => createUnsolicitedClaimSpamRule({ weight: Number.NaN })
    ).toThrow();
    expect(
      () => createUnsolicitedClaimSpamRule({ recipientCountThreshold: 0 })
    ).toThrow();
    expect(
      () => createUnsolicitedClaimSpamRule({ unrelatedRatioThreshold: 1.5 })
    ).toThrow();
    expect(
      () => createUnsolicitedClaimSpamRule({ airdropMaxAssetDiversity: -1 })
    ).toThrow();
    expect(
      () =>
        createUnsolicitedClaimSpamRule({
          airdropRequireUniformAmount: "yes" as never,
        })
    ).toThrow();
  });

  it("uses the default rule weight", () => {
    const rule = createUnsolicitedClaimSpamRule();
    expect(rule.id).toBe("unsolicited-claim-spam");
    expect(rule.weight).toBe(DEFAULT_UNSOLICITED_CLAIM_SPAM_RULE_WEIGHT);
  });
});

describe("createUnsolicitedClaimSpamRule - engine composition", () => {
  it("composes through the rules engine with effective weighting", () => {
    const engine: RuleEngine = createRuleEngine({
      rules: [
        createUnsolicitedClaimSpamRule({
          weight: 0.5,
          recipientCountThreshold: 3,
          airdropMaxAssetDiversity: 0,
        }),
      ],
    });
    const signals = engine.evaluate(
      ruleContext({
        unsolicitedClaimSpamDistinctClaimants: 10,
        unsolicitedClaimSpamUnrelatedClaimants: 10,
        unsolicitedClaimSpamUnrelatedRatio: 1,
        unsolicitedClaimSpamScore: 1,
        claimableBalanceCreatedCount: 10,
        claimableBalanceAssetDiversity: 3,
      })
    );

    expect(signals).toHaveLength(1);
    expect(signals[0].id).toBe("unsolicited-claim-spam");
    expect(signals[0].weight).toBeGreaterThan(0);
    expect(signals[0].weight).toBeLessThanOrEqual(0.5);
  });
});

describe("integration: claimable-balance features feed the rule", () => {
  it("detects unsolicited claim spam end-to-end", () => {
    // Mixed assets and amounts: clearly not an organized single distribution.
    const victims = Array.from({ length: 8 }, (_, i) => `GVICTIM${i}`);
    const assets = ["SPAM", "JUNK", "FREE"];
    const txs = victims.map((victim, i) =>
      createClaimable([victim], {
        balanceId: `spam-batch-${i}`,
        assetCode: assets[i % assets.length],
        assetIssuer: "GISSUER1",
        amount: 0.001 * (i + 1),
      })
    );
    const features = extractClaimableBalanceFeatures(txs, {
      accountId: ACCOUNT,
      now: NOW,
    });
    const rule = createUnsolicitedClaimSpamRule();
    const signal = rule.evaluate(
      claimableBalanceFeaturesToFeatureMap(features)
    );

    expect(signal).not.toBeNull();
    expect(signal?.id).toBe("unsolicited-claim-spam");
  });

  it("distinguishes an organized airdrop end-to-end", () => {
    const holders = Array.from({ length: 8 }, (_, i) => `GHOLDER${i}`);
    const features = extractClaimableBalanceFeatures(
      [
        createClaimable(holders, {
          balanceId: "airdrop-batch",
          assetCode: "USDC",
          assetIssuer: "GISSUER2",
          amount: 25,
          memo: "2026 airdrop",
        }),
      ],
      { accountId: ACCOUNT, now: NOW }
    );
    const rule = createUnsolicitedClaimSpamRule();
    expect(
      rule.evaluate(claimableBalanceFeaturesToFeatureMap(features))
    ).toBeNull();
  });

  it("stays quiet for ordinary claimable-balance activity end-to-end", () => {
    const features = extractClaimableBalanceFeatures(
      [
        createClaimable(["GFRIEND000000000000000000000000000000000000000000000000"], {
          balanceId: "friend-1",
          amount: 100,
        }),
      ],
      { accountId: ACCOUNT, now: NOW }
    );
    const rule = createUnsolicitedClaimSpamRule();
    expect(
      rule.evaluate(claimableBalanceFeaturesToFeatureMap(features))
    ).toBeNull();
  });
});
