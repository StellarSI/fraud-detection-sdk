/**
 * Tests for the trustline-abuse detector rule (issue #27).
 *
 * Acceptance criteria: bursts and extreme counts emit a signal, the signal
 * weight scales with severity, and thresholds are configurable. Cases
 * cover normal, spammy, and burst patterns plus end-to-end composition
 * with the feature extractor and the rules engine.
 */

import { describe, it, expect } from "vitest";
import type {
  Account,
  AccountBalance,
  Transaction,
} from "../clients/horizon.js";
import { RuleEngine, createRuleEngine } from "./engine.js";
import {
  DEFAULT_TRUSTLINE_ABUSE_RULE_WEIGHT,
  createTrustlineAbuseRule,
} from "./trustlineAbuse.js";
import {
  extractTrustlineAbuseFeatures,
  trustlineAbuseFeaturesToFeatureMap,
} from "../features/trustlineAbuse.js";

const NOW = "2026-01-01T12:00:00.000Z";

function ruleContext(overrides: Record<string, number | boolean> = {}) {
  return {
    trustlineCount: 0,
    trustlineChurnCount: 0,
    trustlineBurstCount: 0,
    trustlineBurstDetected: false,
    trustlineDustCount: 0,
    trustlineDustRatio: 0,
    trustlineDistinctIssuersInWindow: 0,
    trustlineExceedsExtremeCount: false,
    trustlineAbuseScore: 0,
    ...overrides,
  };
}

function account(balances: AccountBalance[]): Account {
  return {
    id: "GACCOUNT",
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
  };
}

const native: AccountBalance = {
  code: "XLM",
  type: "native",
  amount: 100,
  clawbackEnabled: false,
  authorized: true,
};

function trustlines(count: number, options: { zero?: number } = {}) {
  const zero = options.zero ?? 0;
  return Array.from({ length: count }, (_, index) => ({
    code: `AST${index}`,
    issuer: `GISSUER${index}`,
    type: "credit_alphanum4",
    amount: index < zero ? 0 : 10,
    clawbackEnabled: false,
    authorized: true,
  }));
}

let nextId = 0;
function changeTrust(overrides: Partial<Transaction> = {}): Transaction {
  nextId += 1;
  return {
    id: `ct-${nextId}`,
    createdAt: "2026-01-01T11:30:00.000Z",
    sourceAccount: "GACCOUNT",
    type: "change_trust",
    amount: 0,
    assetCode: "USD",
    assetIssuer: "GISSUER1",
    pagingToken: String(nextId),
    ...overrides,
  };
}

function burst(count: number) {
  return Array.from({ length: count }, (_, index) =>
    changeTrust({
      createdAt: new Date(Date.UTC(2026, 0, 1, 11, 30 + index)).toISOString(),
      assetCode: `AST${index}`,
      assetIssuer: `GISSUER${index}`,
    })
  );
}

describe("createTrustlineAbuseRule - normal account", () => {
  it("emits no signal without trustline activity", () => {
    const rule = createTrustlineAbuseRule();
    expect(rule.evaluate(ruleContext())).toBeNull();
    expect(rule.evaluate({})).toBeNull();
  });

  it("emits no signal for a small, stable trustline set", () => {
    const rule = createTrustlineAbuseRule();
    const features = extractTrustlineAbuseFeatures(
      account([native, ...trustlines(3)]),
      { transactions: [], now: NOW }
    );

    expect(
      rule.evaluate(trustlineAbuseFeaturesToFeatureMap(features))
    ).toBeNull();
  });
});

describe("createTrustlineAbuseRule - spammy account", () => {
  it("emits a trustline-abuse signal for extreme counts and dusting", () => {
    const rule = createTrustlineAbuseRule();
    const signal = rule.evaluate(
      ruleContext({
        trustlineCount: 150,
        trustlineDustCount: 120,
        trustlineDustRatio: 0.8,
        trustlineExceedsExtremeCount: true,
        trustlineAbuseScore: 0.4,
      })
    );

    expect(signal).not.toBeNull();
    expect(signal?.id).toBe("trustline-abuse");
    expect(signal?.weight).toBeGreaterThan(0);
    expect(signal?.detail ?? "").toMatch(/trustline abuse/i);
    expect(signal?.detail ?? "").toMatch(/dusted/i);
  });

  it("explains the issuer spread for asset spam", () => {
    const rule = createTrustlineAbuseRule();
    const signal = rule.evaluate(
      ruleContext({
        trustlineCount: 12,
        trustlineChurnCount: 12,
        trustlineDistinctIssuersInWindow: 12,
        trustlineAbuseScore: 0.3,
      })
    );

    expect(signal?.detail ?? "").toMatch(/distinct issuers/i);
  });
});

describe("createTrustlineAbuseRule - burst pattern", () => {
  it("emits a signal for a rapid creation burst", () => {
    const rule = createTrustlineAbuseRule();
    const signal = rule.evaluate(
      ruleContext({
        trustlineCount: 3,
        trustlineChurnCount: 12,
        trustlineBurstCount: 12,
        trustlineBurstDetected: true,
        trustlineDistinctIssuersInWindow: 12,
        trustlineAbuseScore: 0.5,
      })
    );

    expect(signal).not.toBeNull();
    expect(signal?.id).toBe("trustline-abuse");
    expect(signal?.detail ?? "").toMatch(/burst window/i);
  });

  it("scales weight with severity", () => {
    const rule = createTrustlineAbuseRule();

    const mild = rule.evaluate(
      ruleContext({
        trustlineCount: 20,
        trustlineChurnCount: 2,
        trustlineBurstCount: 2,
        trustlineAbuseScore: 0.1,
      })
    );
    const severe = rule.evaluate(
      ruleContext({
        trustlineCount: 150,
        trustlineChurnCount: 25,
        trustlineBurstCount: 25,
        trustlineBurstDetected: true,
        trustlineDustCount: 120,
        trustlineDustRatio: 0.8,
        trustlineDistinctIssuersInWindow: 25,
        trustlineExceedsExtremeCount: true,
        trustlineAbuseScore: 0.9,
      })
    );

    expect(mild).not.toBeNull();
    expect(severe).not.toBeNull();
    expect(severe?.weight ?? 0).toBeGreaterThan(mild?.weight ?? 0);
  });
});

describe("createTrustlineAbuseRule - configurable thresholds", () => {
  it("honors a custom burstThreshold", () => {
    const context = ruleContext({
      trustlineCount: 3,
      trustlineChurnCount: 12,
      trustlineBurstCount: 12,
    });

    expect(createTrustlineAbuseRule().evaluate(context)).not.toBeNull();
    expect(
      createTrustlineAbuseRule({
        burstThreshold: 20,
        minScore: 0.3,
      }).evaluate(context)
    ).toBeNull();
  });

  it("honors a custom extremeTrustlineCount", () => {
    const context = ruleContext({
      trustlineCount: 6,
      trustlineAbuseScore: 0.02,
    });

    expect(createTrustlineAbuseRule().evaluate(context)).toBeNull();
    expect(
      createTrustlineAbuseRule({ extremeTrustlineCount: 5 }).evaluate(context)
    ).not.toBeNull();
  });

  it("honors a custom dustRatioThreshold", () => {
    const context = ruleContext({
      trustlineCount: 1,
      trustlineDustCount: 1,
      trustlineDustRatio: 0.2,
      trustlineAbuseScore: 0.02,
    });

    expect(createTrustlineAbuseRule().evaluate(context)).toBeNull();
    expect(
      createTrustlineAbuseRule({ dustRatioThreshold: 0.15 }).evaluate(context)
    ).not.toBeNull();
  });

  it("rejects invalid weights and thresholds", () => {
    expect(() => createTrustlineAbuseRule({ weight: Number.NaN })).toThrow();
    expect(() =>
      createTrustlineAbuseRule({ burstThreshold: 0 })
    ).toThrow();
    expect(() =>
      createTrustlineAbuseRule({ dustRatioThreshold: -1 })
    ).toThrow();
  });
});

describe("createTrustlineAbuseRule - engine composition", () => {
  it("composes through the rules engine with effective weighting", () => {
    const engine = createRuleEngine({
      rules: [createTrustlineAbuseRule({ weight: 0.5 })],
    });
    const signals = engine.evaluate(
      ruleContext({
        trustlineCount: 150,
        trustlineBurstCount: 12,
        trustlineBurstDetected: true,
        trustlineDustCount: 120,
        trustlineDustRatio: 0.8,
        trustlineExceedsExtremeCount: true,
        trustlineAbuseScore: 1,
      })
    );

    expect(signals).toHaveLength(1);
    expect(signals[0].id).toBe("trustline-abuse");
    expect(signals[0].weight).toBeGreaterThan(0);
    expect(signals[0].weight).toBeLessThanOrEqual(0.5);
  });

  it("uses the default rule weight", () => {
    const rule = createTrustlineAbuseRule();
    expect(rule.id).toBe("trustline-abuse");
    expect(rule.weight).toBe(DEFAULT_TRUSTLINE_ABUSE_RULE_WEIGHT);
  });

  it("can be disabled through the engine", () => {
    const engine = new RuleEngine({
      rules: [createTrustlineAbuseRule()],
      enabled: { "trustline-abuse": false },
    });

    expect(
      engine.evaluate(
        ruleContext({ trustlineCount: 150, trustlineAbuseScore: 1 })
      )
    ).toHaveLength(0);
  });
});

describe("integration: features feed the rule", () => {
  it("detects a spam-and-burst account end-to-end", () => {
    const features = extractTrustlineAbuseFeatures(
      account([native, ...trustlines(120, { zero: 100 })]),
      { transactions: burst(12), now: NOW }
    );

    const rule = createTrustlineAbuseRule({ weight: 0.7 });
    const signal = rule.evaluate(trustlineAbuseFeaturesToFeatureMap(features));

    expect(signal).not.toBeNull();
    expect(signal?.id).toBe("trustline-abuse");
    expect(signal?.detail ?? "").toMatch(/extreme threshold/i);
    expect(signal?.detail ?? "").toMatch(/burst window/i);
  });

  it("stays quiet for a normal account end-to-end", () => {
    const features = extractTrustlineAbuseFeatures(
      account([native, ...trustlines(2)]),
      {
        transactions: [
          changeTrust({ createdAt: "2025-12-01T00:00:00.000Z" }),
        ],
        now: NOW,
      }
    );

    const rule = createTrustlineAbuseRule();
    expect(
      rule.evaluate(trustlineAbuseFeaturesToFeatureMap(features))
    ).toBeNull();
  });
});
