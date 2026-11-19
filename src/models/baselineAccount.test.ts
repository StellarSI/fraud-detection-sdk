/**
 * Tests for the per-account behavioral baseline (issue #39).
 *
 * Acceptance criteria: a per-account baseline is computed from history;
 * deviation from baseline yields a signal; baselines persist via the
 * persistence abstraction (#42); unit tests cover normal and deviating
 * behavior.
 */

import { describe, expect, it } from "vitest";
import { RuleEngine, createRuleEngine, type RuleContext } from "../rules/engine.js";
import {
  DEFAULT_BASELINE_RULE_WEIGHT,
  DEFAULT_BASELINE_DEVIATION_THRESHOLD,
  DEFAULT_BASELINE_MIN_OBSERVATIONS,
  BaselineAccount,
  InMemoryBaselineStore,
  createBaselineRule,
} from "./baselineAccount.js";

function ruleContext(overrides: Record<string, number | boolean> = {}): RuleContext {
  return {
    velocityTotalCount: 0,
    graphOutDegree: 0,
    assetDiversity: 0,
    assetTrustlineCount: 0,
    ...overrides,
  };
}

const ACCOUNT = "GACCOUNT00000000000000000000000000000000000000000000000000";

function stableBaselineFeatures(): RuleContext {
  return ruleContext({
    velocityTotalCount: 10,
    graphOutDegree: 3,
    assetDiversity: 2,
    assetTrustlineCount: 4,
  });
}

function deviantFeatures(): RuleContext {
  return ruleContext({
    velocityTotalCount: 40,
    graphOutDegree: 20,
    assetDiversity: 10,
    assetTrustlineCount: 20,
  });
}

describe("BaselineAccount - normal behavior", () => {
  it("stays quiet for an account with no history", () => {
    const baseline = new BaselineAccount();
    const signal = baseline.evaluate(ACCOUNT, ruleContext());

    expect(signal).toBeNull();
  });

  it("stays quiet below the minimum observation count", () => {
    const baseline = new BaselineAccount({ minObservations: 3 });
    baseline.record(ACCOUNT, ruleContext({ velocityTotalCount: 10 }));
    baseline.record(ACCOUNT, ruleContext({ velocityTotalCount: 12 }));

    const signal = baseline.evaluate(ACCOUNT, ruleContext({ velocityTotalCount: 50 }));
    expect(signal).toBeNull();
  });

  it("stays quiet when current features match the baseline", () => {
    const baseline = new BaselineAccount({ minObservations: 2 });
    baseline.record(ACCOUNT, stableBaselineFeatures());
    baseline.record(ACCOUNT, stableBaselineFeatures());

    const signal = baseline.evaluate(ACCOUNT, stableBaselineFeatures());
    expect(signal).toBeNull();
  });

  it("emits a baseline-deviation signal when features deviate beyond the threshold", () => {
    const baseline = new BaselineAccount({
      minObservations: 2,
      deviationThreshold: 1.5,
    });
    baseline.record(ACCOUNT, stableBaselineFeatures());
    baseline.record(ACCOUNT, stableBaselineFeatures());

    const signal = baseline.evaluate(ACCOUNT, deviantFeatures());
    expect(signal).not.toBeNull();
    expect(signal?.id).toBe("baseline-deviation");
    expect(signal?.weight).toBeGreaterThan(0);
    expect(signal?.detail ?? "").toMatch(/baseline deviation/i);
  });

  it("scales weight with deviation severity", () => {
    const baseline = new BaselineAccount({ minObservations: 2, deviationThreshold: 1 });
    // varied history gives the baseline a non-zero standard deviation
    baseline.record(ACCOUNT, ruleContext({ velocityTotalCount: 10 }));
    baseline.record(ACCOUNT, ruleContext({ velocityTotalCount: 12 }));

    const mild = baseline.evaluate(ACCOUNT, ruleContext({ velocityTotalCount: 13 }));
    const severe = baseline.evaluate(ACCOUNT, ruleContext({ velocityTotalCount: 15 }));

    expect(mild).not.toBeNull();
    expect(severe).not.toBeNull();
    expect(severe?.weight ?? 0).toBeGreaterThan(mild?.weight ?? 0);
  });

  it("honors a custom deviation threshold", () => {
    const strict = new BaselineAccount({
      minObservations: 2,
      deviationThreshold: 5,
    });
    strict.record(ACCOUNT, ruleContext({ velocityTotalCount: 10 }));
    strict.record(ACCOUNT, ruleContext({ velocityTotalCount: 12 }));

    // z-score ~1.41 for velocity=13, below the strict threshold of 5
    expect(strict.evaluate(ACCOUNT, ruleContext({ velocityTotalCount: 13 }))).toBeNull();

    const loose = new BaselineAccount({
      minObservations: 2,
      deviationThreshold: 0.5,
    });
    loose.record(ACCOUNT, ruleContext({ velocityTotalCount: 10 }));
    loose.record(ACCOUNT, ruleContext({ velocityTotalCount: 12 }));
    expect(
      loose.evaluate(ACCOUNT, ruleContext({ velocityTotalCount: 13 }))
    ).not.toBeNull();
  });

  it("persists snapshots through the store", () => {
    const store = new InMemoryBaselineStore();
    const baseline = new BaselineAccount({ store });
    baseline.record(ACCOUNT, stableBaselineFeatures());
    baseline.record(ACCOUNT, stableBaselineFeatures());

    const snapshot = store.get(ACCOUNT);
    expect(snapshot).not.toBeUndefined();
    expect(snapshot?.accountId).toBe(ACCOUNT);
    expect(snapshot?.observationCount).toBe(2);
    expect(snapshot?.velocity.mean).toBe(10);
  });

  it("loads an existing snapshot from the store", () => {
    const store = new InMemoryBaselineStore();
    store.set(ACCOUNT, {
      accountId: ACCOUNT,
      observationCount: 3,
      velocity: { count: 3, mean: 10, m2: 2 },
      counterpartyCount: { count: 3, mean: 3, m2: 0 },
      assetDiversity: { count: 3, mean: 2, m2: 0 },
      trustlineCount: { count: 3, mean: 4, m2: 0 },
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    const baseline = new BaselineAccount({ store });
    // Velocity of 30 vs mean 10 with stddev ~1 -> z ~ 20, well above threshold.
    const signal = baseline.evaluate(ACCOUNT, ruleContext({ velocityTotalCount: 30 }));
    expect(signal).not.toBeNull();
    expect(signal?.id).toBe("baseline-deviation");
  });

  it("deletes a baseline from the store", () => {
    const store = new InMemoryBaselineStore();
    const baseline = new BaselineAccount({ store });
    baseline.record(ACCOUNT, stableBaselineFeatures());

    expect(store.get(ACCOUNT)).not.toBeUndefined();
    baseline.delete(ACCOUNT);
    expect(store.get(ACCOUNT)).toBeUndefined();
  });
});

describe("createBaselineRule", () => {
  it("emits no signal for normal behavior", () => {
    const rule = createBaselineRule({ minObservations: 2, deviationThreshold: 1.5 });
    baselineRuleRecord(rule, ACCOUNT, stableBaselineFeatures());
    baselineRuleRecord(rule, ACCOUNT, stableBaselineFeatures());

    expect(rule.evaluate(ruleContext({ ...stableBaselineFeatures(), accountId: ACCOUNT }))).toBeNull();
  });

  it("emits a signal for deviating behavior", () => {
    const rule = createBaselineRule({ minObservations: 2, deviationThreshold: 1.5 });
    baselineRuleRecord(rule, ACCOUNT, stableBaselineFeatures());
    baselineRuleRecord(rule, ACCOUNT, stableBaselineFeatures());

    const signal = rule.evaluate(ruleContext({ ...deviantFeatures(), accountId: ACCOUNT }));
    expect(signal).not.toBeNull();
    expect(signal?.id).toBe("baseline-deviation");
  });

  it("uses the default account id from options when context lacks one", () => {
    const rule = createBaselineRule({
      minObservations: 2,
      deviationThreshold: 1.5,
      accountId: ACCOUNT,
    });
    baselineRuleRecord(rule, ACCOUNT, stableBaselineFeatures());
    baselineRuleRecord(rule, ACCOUNT, stableBaselineFeatures());

    const signal = rule.evaluate(ruleContext(deviantFeatures()));
    expect(signal).not.toBeNull();
    expect(signal?.id).toBe("baseline-deviation");
  });

  it("uses the documented defaults", () => {
    const rule = createBaselineRule();
    expect(rule.id).toBe("baseline-deviation");
    expect(rule.weight).toBe(DEFAULT_BASELINE_RULE_WEIGHT);
    expect(DEFAULT_BASELINE_MIN_OBSERVATIONS).toBe(2);
    expect(DEFAULT_BASELINE_DEVIATION_THRESHOLD).toBe(2);
  });

  it("composes through the rules engine", () => {
    const rule = createBaselineRule({
      minObservations: 2,
      deviationThreshold: 1.5,
    });
    baselineRuleRecord(rule, ACCOUNT, stableBaselineFeatures());
    baselineRuleRecord(rule, ACCOUNT, stableBaselineFeatures());

    const engine: RuleEngine = createRuleEngine({ rules: [rule] });
    const signals = engine.evaluate(
      ruleContext({ ...deviantFeatures(), accountId: ACCOUNT })
    );
    expect(signals).toHaveLength(1);
    expect(signals[0].id).toBe("baseline-deviation");
    expect(signals[0].weight).toBeGreaterThan(0);
  });
});

function baselineRuleRecord(
  rule: Rule & { record?: (accountId: string, features: RuleContext) => void },
  accountId: string,
  features: RuleContext
): void {
  if (rule.record) rule.record(accountId, features);
}
