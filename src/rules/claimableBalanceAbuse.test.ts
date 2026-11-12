/**
 * Tests for the claimable-balance abuse detector rule (issue #31).
 *
 * Acceptance criteria: claimable balance creation is detected; unclaimed or
 * mass-created balances emit a signal; thresholds are configurable; and
 * cases cover claimed, unclaimed, and mass scenarios.
 */

import { describe, it, expect } from "vitest";
import type { Transaction } from "../clients/horizon.js";
import { RuleEngine, createRuleEngine } from "./engine.js";
import {
  DEFAULT_CLAIMABLE_BALANCE_ABUSE_RULE_WEIGHT,
  createClaimableBalanceAbuseRule,
} from "./claimableBalanceAbuse.js";
import {
  extractClaimableBalanceFeatures,
  claimableBalanceFeaturesToFeatureMap,
} from "../features/claimableBalances.js";

const ACCOUNT =
  "GACCOUNT00000000000000000000000000000000000000000000000000";
const NOW = Date.parse("2026-06-01T00:00:00.000Z");

function ruleContext(overrides: Record<string, number | boolean> = {}) {
  return {
    claimableBalanceCreatedCount: 0,
    claimableBalanceClaimantsCount: 0,
    claimableBalanceCreatedCountInWindow: 0,
    claimableBalanceClaimantsCountInWindow: 0,
    claimableBalanceBurstCount: 0,
    claimableBalanceBurstDetected: false,
    claimableBalanceExtremeCountDetected: false,
    claimableBalanceClaimObservedCount: 0,
    claimableBalanceUnclaimedCount: 0,
    claimableBalanceUnclaimedRatio: 0,
    claimableBalanceAbuseScore: 0,
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
    id: `cb-${nextId}`,
    createdAt: "2026-05-20T00:00:00.000Z",
    sourceAccount: ACCOUNT,
    type: "create_claimable_balance",
    amount: 1,
    from: ACCOUNT,
    claimants,
    pagingToken: String(nextId),
    ...overrides,
  };
}

describe("createClaimableBalanceAbuseRule - claimed case", () => {
  it("emits no signal when created balances are claimed promptly", () => {
    const rule = createClaimableBalanceAbuseRule();
    const signal = rule.evaluate(
      ruleContext({
        claimableBalanceCreatedCount: 3,
        claimableBalanceClaimantsCount: 3,
        claimableBalanceClaimObservedCount: 3,
        claimableBalanceUnclaimedCount: 0,
        claimableBalanceUnclaimedRatio: 0,
        claimableBalanceAbuseScore: 0,
      })
    );

    expect(signal).toBeNull();
  });
});

describe("createClaimableBalanceAbuseRule - unclaimed case", () => {
  it("emits a signal for balances left unclaimed past the staleness threshold", () => {
    const rule = createClaimableBalanceAbuseRule();
    const signal = rule.evaluate(
      ruleContext({
        claimableBalanceCreatedCount: 6,
        claimableBalanceClaimantsCount: 6,
        claimableBalanceUnclaimedCount: 5,
        claimableBalanceUnclaimedRatio: 5 / 6,
        claimableBalanceAbuseScore: 0.6,
      })
    );

    expect(signal).not.toBeNull();
    expect(signal?.id).toBe("claimable-balance-abuse");
    expect(signal?.weight).toBeGreaterThan(0);
    expect(signal?.detail ?? "").toMatch(/unclaimed/i);
  });

  it("scales weight with the unclaimed ratio", () => {
    const rule = createClaimableBalanceAbuseRule();
    const mild = rule.evaluate(
      ruleContext({
        claimableBalanceCreatedCount: 4,
        claimableBalanceClaimantsCount: 4,
        claimableBalanceUnclaimedCount: 1,
        claimableBalanceUnclaimedRatio: 0.25,
      })
    );
    const severe = rule.evaluate(
      ruleContext({
        claimableBalanceCreatedCount: 4,
        claimableBalanceClaimantsCount: 4,
        claimableBalanceUnclaimedCount: 4,
        claimableBalanceUnclaimedRatio: 1,
      })
    );

    expect(mild).not.toBeNull();
    expect(severe).not.toBeNull();
    expect(severe?.weight ?? 0).toBeGreaterThan(mild?.weight ?? 0);
  });
});

describe("createClaimableBalanceAbuseRule - mass-creation case", () => {
  it("emits a stronger signal for mass-created balances", () => {
    const rule = createClaimableBalanceAbuseRule({ extremeCount: 20 });
    const small = rule.evaluate(
      ruleContext({
        claimableBalanceCreatedCount: 2,
        claimableBalanceClaimantsCount: 2,
      })
    );
    const mass = rule.evaluate(
      ruleContext({
        claimableBalanceCreatedCount: 30,
        claimableBalanceClaimantsCount: 30,
        claimableBalanceBurstCount: 12,
        claimableBalanceBurstDetected: true,
      })
    );

    expect(small).toBeNull();
    expect(mass).not.toBeNull();
    expect(mass?.detail ?? "").toMatch(/extreme/i);
    expect(mass?.weight ?? 0).toBeGreaterThan(0);
  });

  it("emits a signal on burst activity even below the extreme count", () => {
    const rule = createClaimableBalanceAbuseRule({
      extremeCount: 50,
      burstThreshold: 5,
    });
    const signal = rule.evaluate(
      ruleContext({
        claimableBalanceCreatedCount: 6,
        claimableBalanceClaimantsCount: 6,
        claimableBalanceBurstCount: 6,
        claimableBalanceBurstDetected: true,
      })
    );

    expect(signal).not.toBeNull();
    expect(signal?.id).toBe("claimable-balance-abuse");
  });
});

describe("createClaimableBalanceAbuseRule - configurable thresholds", () => {
  it("honors a custom extremeCount", () => {
    const context = ruleContext({
      claimableBalanceCreatedCount: 8,
      claimableBalanceClaimantsCount: 8,
      claimableBalanceBurstCount: 2,
    });

    expect(
      createClaimableBalanceAbuseRule({ extremeCount: 5 }).evaluate(context)
    ).not.toBeNull();
    expect(
      createClaimableBalanceAbuseRule({ extremeCount: 100, burstThreshold: 100 }).evaluate(
        ruleContext({ ...context, claimableBalanceBurstCount: 0 })
      )
    ).toBeNull();
  });

  it("honors a custom unclaimedRatioThreshold", () => {
    const context = ruleContext({
      claimableBalanceCreatedCount: 10,
      claimableBalanceClaimantsCount: 10,
      claimableBalanceUnclaimedCount: 2,
      claimableBalanceUnclaimedRatio: 0.2,
    });

    const strict = createClaimableBalanceAbuseRule({ unclaimedRatioThreshold: 0.1 });
    const lenient = createClaimableBalanceAbuseRule({
      unclaimedRatioThreshold: 0.9,
      extremeCount: 10_000,
      burstThreshold: 10_000,
      minScore: 0.9,
    });

    expect(strict.evaluate(context)).not.toBeNull();
    expect(lenient.evaluate(context)).toBeNull();
  });

  it("rejects invalid numeric options", () => {
    expect(() => createClaimableBalanceAbuseRule({ weight: Number.NaN })).toThrow();
    expect(() => createClaimableBalanceAbuseRule({ extremeCount: 0 })).toThrow();
    expect(() => createClaimableBalanceAbuseRule({ burstThreshold: -1 })).toThrow();
    expect(
      () => createClaimableBalanceAbuseRule({ unclaimedRatioThreshold: 2 })
    ).toThrow();
  });

  it("uses the default rule weight", () => {
    const rule = createClaimableBalanceAbuseRule();
    expect(rule.id).toBe("claimable-balance-abuse");
    expect(rule.weight).toBe(DEFAULT_CLAIMABLE_BALANCE_ABUSE_RULE_WEIGHT);
  });
});

describe("createClaimableBalanceAbuseRule - engine composition", () => {
  it("composes through the rules engine with effective weighting", () => {
    const engine: RuleEngine = createRuleEngine({
      rules: [
        createClaimableBalanceAbuseRule({
          weight: 0.5,
          unclaimedRatioThreshold: 0.1,
        }),
      ],
    });
    const signals = engine.evaluate(
      ruleContext({
        claimableBalanceCreatedCount: 8,
        claimableBalanceClaimantsCount: 8,
        claimableBalanceUnclaimedCount: 7,
        claimableBalanceUnclaimedRatio: 0.875,
        claimableBalanceAbuseScore: 1,
      })
    );

    expect(signals).toHaveLength(1);
    expect(signals[0].id).toBe("claimable-balance-abuse");
    expect(signals[0].weight).toBeGreaterThan(0);
    expect(signals[0].weight).toBeLessThanOrEqual(0.5);
  });
});

describe("integration: claimable-balance features feed the rule", () => {
  it("detects unclaimed balances end-to-end", () => {
    const txs = Array.from({ length: 6 }, (_, i) => {
      nextId += 1;
      return createClaimable([`GSTALE${i}`], {
        balanceId: `stale-${i}`,
        createdAt: "2026-04-01T00:00:00.000Z",
      });
    });
    const features = extractClaimableBalanceFeatures(txs, {
      accountId: ACCOUNT,
      now: NOW,
    });
    const rule = createClaimableBalanceAbuseRule();
    const signal = rule.evaluate(claimableBalanceFeaturesToFeatureMap(features));

    expect(signal).not.toBeNull();
    expect(signal?.id).toBe("claimable-balance-abuse");
  });

  it("stays quiet for claimed balances end-to-end", () => {
    nextId = 0;
    const create = createClaimable(["GCLM1"], {
      balanceId: "claimed-1",
      createdAt: "2026-04-01T00:00:00.000Z",
    });
    const claim: Transaction = {
      id: "claim-1",
      createdAt: "2026-04-02T00:00:00.000Z",
      sourceAccount: "GCLAIMER0000000000000000000000000000000000000000000000000",
      type: "claim_claimable_balance",
      amount: 1,
      balanceId: "claimed-1",
      pagingToken: "claim-1",
    };
    const features = extractClaimableBalanceFeatures([create, claim], {
      accountId: ACCOUNT,
      now: NOW,
    });
    const rule = createClaimableBalanceAbuseRule();
    expect(
      rule.evaluate(claimableBalanceFeaturesToFeatureMap(features))
    ).toBeNull();
  });
});
