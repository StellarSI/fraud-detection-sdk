/**
 * Tests for the clawback-enabled asset activity detector rule (issue #36).
 *
 * Acceptance criteria: clawback operations and unusual volume/frequency
 * emit a `clawback-activity` signal with context; thresholds are
 * configurable; normal and unusual clawback activity are distinguished in
 * unit tests; the rule composes through the rules engine (#25).
 */

import { describe, it, expect } from "vitest";
import { ValidationError } from "../errors.js";
import { createRuleEngine } from "./engine.js";
import {
  DEFAULT_CLAWBACK_ACTIVITY_RULE_WEIGHT,
  DEFAULT_CLAWBACK_ACTIVITY_MIN_SCORE,
  createClawbackActivityRule,
} from "./clawbackActivity.js";
import {
  extractClawbackActivityFeatures,
  clawbackActivityFeaturesToFeatureMap,
} from "../features/clawbackActivity.js";

function ruleContext(overrides: Record<string, number | boolean> = {}) {
  return {
    clawbackEnabledAssetCount: 1,
    clawbackTransactionCount: 0,
    clawbackOperationCount: 0,
    clawbackBurstCount: 0,
    clawbackBurstDetected: false,
    clawbackDistinctAssetCount: 0,
    clawbackTotalVolume: 0,
    clawbackMaxAmount: 0,
    ...overrides,
  };
}

describe("createClawbackActivityRule - unusual activity", () => {
  it("emits a signal for a clawback operation", () => {
    const rule = createClawbackActivityRule();
    const signal = rule.evaluate(
      ruleContext({ clawbackOperationCount: 1, clawbackTransactionCount: 1 })
    );
    expect(signal).not.toBeNull();
    expect(signal?.id).toBe("clawback-activity");
    expect(signal?.weight).toBeGreaterThan(0);
    expect(signal?.detail ?? "").toMatch(/clawback operation/i);
  });

  it("emits a signal for unusual volume", () => {
    const rule = createClawbackActivityRule();
    const signal = rule.evaluate(
      ruleContext({
        clawbackTransactionCount: 1,
        clawbackTotalVolume: 1500,
        clawbackMaxAmount: 1500,
      })
    );
    expect(signal).not.toBeNull();
    expect(signal?.detail ?? "").toMatch(/volume/i);
  });

  it("emits a signal for unusual frequency and bursts", () => {
    const rule = createClawbackActivityRule();
    const signal = rule.evaluate(
      ruleContext({
        clawbackTransactionCount: 5,
        clawbackBurstCount: 4,
        clawbackBurstDetected: true,
      })
    );
    expect(signal).not.toBeNull();
    expect(signal?.detail ?? "").toMatch(/burst window/i);
  });

  it("scales severity with the number of clawback operations", () => {
    const rule = createClawbackActivityRule();
    const mild = rule.evaluate(ruleContext({ clawbackOperationCount: 1 }));
    const severe = rule.evaluate(ruleContext({ clawbackOperationCount: 4 }));
    expect(severe?.weight ?? 0).toBeGreaterThan(mild?.weight ?? 0);
  });
});

describe("createClawbackActivityRule - normal activity", () => {
  it("emits no signal for an empty context or no clawback assets", () => {
    const rule = createClawbackActivityRule();
    expect(rule.evaluate({})).toBeNull();
    expect(rule.evaluate(ruleContext({ clawbackEnabledAssetCount: 0 }))).toBeNull();
  });

  it("stays quiet for ordinary activity on clawback-enabled assets", () => {
    const rule = createClawbackActivityRule();
    const signal = rule.evaluate(
      ruleContext({
        clawbackTransactionCount: 1,
        clawbackTotalVolume: 10,
        clawbackMaxAmount: 10,
      })
    );
    expect(signal).toBeNull();
  });
});

describe("createClawbackActivityRule - configuration", () => {
  it("honors custom thresholds", () => {
    const strictVolume = createClawbackActivityRule({ volumeThreshold: 100 });
    expect(
      strictVolume.evaluate(
        ruleContext({ clawbackTransactionCount: 1, clawbackTotalVolume: 150 })
      )
    ).not.toBeNull();

    const lenient = createClawbackActivityRule({ volumeThreshold: 1_000_000 });
    expect(
      lenient.evaluate(
        ruleContext({ clawbackTransactionCount: 1, clawbackTotalVolume: 150 })
      )
    ).toBeNull();
  });

  it("can silence individual alert classes", () => {
    const noOperations = createClawbackActivityRule({
      enableOperationAlerts: false,
    });
    expect(
      noOperations.evaluate(ruleContext({ clawbackOperationCount: 2 }))
    ).toBeNull();

    expect(
      () =>
        createClawbackActivityRule({
          enableOperationAlerts: false,
          enableVolumeAnomalies: false,
          enableFrequencyAnomalies: false,
        })
    ).toThrow(ValidationError);
  });

  it("validates option values", () => {
    expect(() => createClawbackActivityRule({ weight: Number.NaN })).toThrow(
      ValidationError
    );
    expect(() => createClawbackActivityRule({ minScore: 2 })).toThrow(
      ValidationError
    );
    expect(() => createClawbackActivityRule({ volumeThreshold: 0 })).toThrow(
      ValidationError
    );
    expect(() =>
      createClawbackActivityRule({ operationThreshold: 1.5 })
    ).toThrow(ValidationError);
  });

  it("exposes documented defaults", () => {
    expect(DEFAULT_CLAWBACK_ACTIVITY_RULE_WEIGHT).toBe(0.6);
    expect(DEFAULT_CLAWBACK_ACTIVITY_MIN_SCORE).toBe(0.05);
  });
});

describe("clawback activity rule integration", () => {
  it("composes with the rules engine and the feature extractor", () => {
    const transactions = [
      {
        id: "cb-1",
        createdAt: "2026-01-01T12:00:00.000Z",
        sourceAccount: "GOTHER00000000000000000000000000000000000000000000000000000",
        type: "clawback",
        amount: 2500,
        assetCode: "USD",
        assetIssuer: "GISSUER0000000000000000000000000000000000000000000000000000",
        from: "GISSUER0000000000000000000000000000000000000000000000000000",
        to: "GACCOUNT00000000000000000000000000000000000000000000000000",
        pagingToken: "1",
      },
    ];
    const account = {
      id: "GACCOUNT00000000000000000000000000000000000000000000000000",
      sequence: 1,
      sequenceString: "1",
      signatureThreshold: 0,
      subentryCount: 1,
      thresholds: { low: 0, medium: 0, high: 0 },
      balances: [
        {
          code: "USD",
          issuer: "GISSUER0000000000000000000000000000000000000000000000000000",
          type: "credit_alphanum4",
          amount: 1000,
          clawbackEnabled: true,
          authorized: true,
        },
      ],
      signers: [],
      data: {},
      lastLedger: 1,
      pagingToken: "1",
    };

    const features = clawbackActivityFeaturesToFeatureMap(
      extractClawbackActivityFeatures(account, transactions, {
        now: "2026-01-01T12:00:00.000Z",
        accountId: account.id,
      })
    );
    const engine = createRuleEngine({
      rules: [createClawbackActivityRule()],
    });
    const signals = engine.evaluate(features);
    expect(signals).toHaveLength(1);
    expect(signals[0]?.id).toBe("clawback-activity");
    expect(signals[0]?.weight).toBeGreaterThan(0);
    expect(signals[0]?.weight).toBeLessThanOrEqual(DEFAULT_CLAWBACK_ACTIVITY_RULE_WEIGHT);
  });
});
