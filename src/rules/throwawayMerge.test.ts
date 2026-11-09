/**
 * Tests for the throwaway-account and rapid-merge detector rule (issue #29).
 *
 * Acceptance criteria: young, rapidly-merged accounts emit a signal;
 * legitimate older migrations do not; thresholds are configurable; and
 * cases cover young-merge, old-merge, and no-merge scenarios.
 */

import { describe, it, expect } from "vitest";
import type { Transaction } from "../clients/horizon.js";
import { RuleEngine, createRuleEngine } from "./engine.js";
import {
  DEFAULT_THROWAWAY_MERGE_RULE_WEIGHT,
  createThrowawayMergeRule,
} from "./throwawayMerge.js";
import {
  extractLifecycleFeatures,
  lifecycleFeaturesToFeatureMap,
} from "../features/lifecycle.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const NOW = "2026-01-31T12:00:00.000Z";
const ACCOUNT = "GACCOUNT00000000000000000000000000000000000000000000000000";
const FUNDER = "GFUNDER000000000000000000000000000000000000000000000000000";

function ruleContext(overrides: Record<string, number | boolean | null> = {}) {
  return {
    accountAgeMs: 60 * DAY_MS,
    accountMergeCount: 0,
    msToFirstMerge: null,
    ...overrides,
  };
}

let nextId = 0;
function tx(overrides: Partial<Transaction> = {}): Transaction {
  nextId += 1;
  return {
    id: `tx-${nextId}`,
    createdAt: NOW,
    sourceAccount: ACCOUNT,
    type: "payment",
    amount: 1,
    pagingToken: String(nextId),
    ...overrides,
  };
}

describe("createThrowawayMergeRule - young-merge case", () => {
  it("emits a throwaway-account signal for a young, rapidly-merged account", () => {
    const rule = createThrowawayMergeRule({ weight: 0.55 });
    const signal = rule.evaluate(
      ruleContext({
        accountAgeMs: 2 * DAY_MS,
        accountMergeCount: 1,
        msToFirstMerge: 6 * HOUR_MS,
      })
    );

    expect(signal).not.toBeNull();
    expect(signal?.id).toBe("throwaway-account");
    expect(signal?.weight).toBeGreaterThan(0);
    expect(signal?.detail ?? "").toMatch(/throwaway-account/i);
    expect(signal?.detail ?? "").toMatch(/merge operation/i);
  });

  it("scales severity for faster merges and younger accounts", () => {
    const rule = createThrowawayMergeRule();

    const mild = rule.evaluate(
      ruleContext({
        accountAgeMs: 20 * DAY_MS,
        accountMergeCount: 1,
        msToFirstMerge: 6 * DAY_MS,
      })
    );
    const severe = rule.evaluate(
      ruleContext({
        accountAgeMs: 1 * DAY_MS,
        accountMergeCount: 2,
        msToFirstMerge: 1 * HOUR_MS,
      })
    );

    expect(mild).not.toBeNull();
    expect(severe).not.toBeNull();
    expect(severe?.weight ?? 0).toBeGreaterThan(mild?.weight ?? 0);
  });
});

describe("createThrowawayMergeRule - old-merge case", () => {
  it("does not flag an older account that merged (legitimate migration)", () => {
    const rule = createThrowawayMergeRule();
    const signal = rule.evaluate(
      ruleContext({
        accountAgeMs: 120 * DAY_MS,
        accountMergeCount: 1,
        msToFirstMerge: 2 * HOUR_MS,
      })
    );

    expect(signal).toBeNull();
  });

  it("does not flag a young account whose merge happened long after creation", () => {
    const rule = createThrowawayMergeRule({
      youngAccountMaxAgeMs: 60 * DAY_MS,
      maxMsToFirstMergeMs: 7 * DAY_MS,
    });
    const signal = rule.evaluate(
      ruleContext({
        accountAgeMs: 45 * DAY_MS,
        accountMergeCount: 1,
        msToFirstMerge: 30 * DAY_MS,
      })
    );

    expect(signal).toBeNull();
  });
});

describe("createThrowawayMergeRule - no-merge case", () => {
  it("emits no signal when there are no merge operations", () => {
    const rule = createThrowawayMergeRule();
    expect(
      rule.evaluate(
        ruleContext({
          accountAgeMs: 1 * DAY_MS,
          accountMergeCount: 0,
          msToFirstMerge: null,
        })
      )
    ).toBeNull();
    expect(rule.evaluate({})).toBeNull();
  });

  it("emits no signal when merge timing is unknown", () => {
    const rule = createThrowawayMergeRule();
    expect(
      rule.evaluate(
        ruleContext({
          accountAgeMs: 1 * DAY_MS,
          accountMergeCount: 1,
          msToFirstMerge: null,
        })
      )
    ).toBeNull();
  });
});

describe("createThrowawayMergeRule - configurable thresholds", () => {
  it("honors a custom youngAccountMaxAgeMs", () => {
    const context = ruleContext({
      accountAgeMs: 10 * DAY_MS,
      accountMergeCount: 1,
      msToFirstMerge: 1 * DAY_MS,
    });

    expect(createThrowawayMergeRule({ youngAccountMaxAgeMs: 30 * DAY_MS }).evaluate(context)).not.toBeNull();
    expect(createThrowawayMergeRule({ youngAccountMaxAgeMs: 5 * DAY_MS }).evaluate(context)).toBeNull();
  });

  it("honors a custom minMergeCount", () => {
    const context = ruleContext({
      accountAgeMs: 2 * DAY_MS,
      accountMergeCount: 1,
      msToFirstMerge: 2 * HOUR_MS,
    });

    expect(createThrowawayMergeRule({ minMergeCount: 1 }).evaluate(context)).not.toBeNull();
    expect(createThrowawayMergeRule({ minMergeCount: 2 }).evaluate(context)).toBeNull();
  });

  it("honors a custom maxMsToFirstMergeMs", () => {
    const context = ruleContext({
      accountAgeMs: 10 * DAY_MS,
      accountMergeCount: 1,
      msToFirstMerge: 3 * DAY_MS,
    });

    expect(createThrowawayMergeRule({ maxMsToFirstMergeMs: 7 * DAY_MS }).evaluate(context)).not.toBeNull();
    expect(createThrowawayMergeRule({ maxMsToFirstMergeMs: 1 * DAY_MS }).evaluate(context)).toBeNull();
  });

  it("rejects invalid numeric options", () => {
    expect(() => createThrowawayMergeRule({ weight: Number.NaN })).toThrow();
    expect(() => createThrowawayMergeRule({ youngAccountMaxAgeMs: 0 })).toThrow();
    expect(() => createThrowawayMergeRule({ maxMsToFirstMergeMs: -1 })).toThrow();
  });

  it("uses the default rule weight", () => {
    const rule = createThrowawayMergeRule();
    expect(rule.id).toBe("throwaway-account");
    expect(rule.weight).toBe(DEFAULT_THROWAWAY_MERGE_RULE_WEIGHT);
  });
});

describe("createThrowawayMergeRule - engine composition", () => {
  it("composes through the rules engine with effective weighting", () => {
    const engine = createRuleEngine({
      rules: [createThrowawayMergeRule({ weight: 0.5 })],
    });
    const signals = engine.evaluate(
      ruleContext({
        accountAgeMs: 1 * DAY_MS,
        accountMergeCount: 1,
        msToFirstMerge: 1 * HOUR_MS,
      })
    );

    expect(signals).toHaveLength(1);
    expect(signals[0].id).toBe("throwaway-account");
    expect(signals[0].weight).toBeGreaterThan(0);
    expect(signals[0].weight).toBeLessThanOrEqual(0.5);
  });

  it("can be disabled through the engine", () => {
    const engine = new RuleEngine({
      rules: [createThrowawayMergeRule()],
      enabled: { "throwaway-account": false },
    });

    expect(
      engine.evaluate(
        ruleContext({ accountAgeMs: 1 * DAY_MS, accountMergeCount: 1, msToFirstMerge: 1 * HOUR_MS })
      )
    ).toHaveLength(0);
  });
});

describe("integration: lifecycle features feed the rule", () => {
  it("detects a young account merged rapidly end-to-end", () => {
    const createdAt = "2026-01-30T12:00:00.000Z";
    const mergedAt = "2026-01-30T14:00:00.000Z";
    const features = extractLifecycleFeatures(
      [
        tx({
          type: "create_account",
          createdAt,
          from: FUNDER,
          to: ACCOUNT,
          sourceAccount: FUNDER,
        }),
        tx({ type: "account_merge", createdAt: mergedAt, sourceAccount: ACCOUNT, from: ACCOUNT }),
      ],
      { accountId: ACCOUNT, now: NOW }
    );

    const rule = createThrowawayMergeRule({ weight: 0.6 });
    const signal = rule.evaluate(lifecycleFeaturesToFeatureMap(features));

    expect(signal).not.toBeNull();
    expect(signal?.id).toBe("throwaway-account");
  });

  it("stays quiet for an old account with a late merge end-to-end", () => {
    const features = extractLifecycleFeatures(
      [
        tx({
          type: "create_account",
          createdAt: "2025-01-01T00:00:00.000Z",
          from: FUNDER,
          to: ACCOUNT,
          sourceAccount: FUNDER,
        }),
        tx({
          type: "account_merge",
          createdAt: "2026-01-20T00:00:00.000Z",
          sourceAccount: ACCOUNT,
          from: ACCOUNT,
        }),
      ],
      { accountId: ACCOUNT, now: NOW }
    );

    const rule = createThrowawayMergeRule();
    expect(rule.evaluate(lifecycleFeaturesToFeatureMap(features))).toBeNull();
  });
});
