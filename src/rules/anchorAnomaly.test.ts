/**
 * Tests for the anchor deposit/withdrawal anomaly detector rule (issue #34).
 *
 * Acceptance criteria: irregular memo and amount patterns around anchor
 * interactions emit an `anchor-anomaly` signal; normal anchor activity
 * emits nothing; thresholds and anomaly classes are configurable; unit
 * tests cover normal and anomalous anchor activity; the rule composes
 * through the rules engine (#25).
 */

import { describe, it, expect } from "vitest";
import type { Transaction } from "../clients/horizon.js";
import { RuleEngine, createRuleEngine } from "./engine.js";
import {
  DEFAULT_ANCHOR_ANOMALY_RULE_WEIGHT,
  DEFAULT_ANCHOR_ANOMALY_MIN_SCORE,
  DEFAULT_ANCHOR_ANOMALY_MIN_TRANSACTIONS,
  DEFAULT_ANCHOR_ANOMALY_MISSING_MEMO_RATIO,
  DEFAULT_ANCHOR_ANOMALY_MEMO_REUSE_THRESHOLD,
  DEFAULT_ANCHOR_ANOMALY_CONCENTRATION_THRESHOLD,
  DEFAULT_ANCHOR_ANOMALY_OUTLIER_THRESHOLD,
  createAnchorAnomalyRule,
} from "./anchorAnomaly.js";
import {
  extractAnchorAnomalyFeatures,
  anchorAnomalyFeaturesToFeatureMap,
} from "../features/anchorAnomaly.js";

const ACCOUNT =
  "GACCOUNT00000000000000000000000000000000000000000000000000";
const ANCHOR_ISSUER =
  "GANCHORISSUER000000000000000000000000000000000000000000000";

function ruleContext(overrides: Record<string, number | boolean> = {}) {
  return {
    anchorTransactionCount: 0,
    anchorInboundCount: 0,
    anchorOutboundCount: 0,
    anchorDistinctAssetCount: 0,
    anchorTotalVolume: 0,
    anchorAmountMean: 0,
    anchorAmountMin: 0,
    anchorAmountMax: 0,
    anchorAmountStdDev: 0,
    anchorAmountMaxShare: 0,
    anchorAmountOutlierCount: 0,
    anchorMemoCount: 0,
    anchorMemoMissingCount: 0,
    anchorMemoIdCount: 0,
    anchorMemoDistinctCount: 0,
    anchorMemoReusedCount: 0,
    anchorMemoMaxReuseCount: 0,
    anchorMemoShare: 0,
    ...overrides,
  };
}

/** A stable anchor baseline: regular amounts, unique memos. */
const NORMAL_CONTEXT = ruleContext({
  anchorTransactionCount: 5,
  anchorInboundCount: 3,
  anchorOutboundCount: 2,
  anchorDistinctAssetCount: 1,
  anchorTotalVolume: 500,
  anchorAmountMean: 100,
  anchorAmountMin: 100,
  anchorAmountMax: 100,
  anchorAmountStdDev: 0,
  anchorAmountMaxShare: 0.2,
  anchorAmountOutlierCount: 0,
  anchorMemoCount: 5,
  anchorMemoMissingCount: 0,
  anchorMemoIdCount: 5,
  anchorMemoDistinctCount: 5,
  anchorMemoMaxReuseCount: 1,
  anchorMemoShare: 1,
});

describe("createAnchorAnomalyRule - normal anchor activity", () => {
  it("emits no signal for a stable, regular anchor baseline", () => {
    const rule = createAnchorAnomalyRule();
    expect(rule.evaluate(NORMAL_CONTEXT)).toBeNull();
  });

  it("emits no signal when there are no anchor transactions", () => {
    const rule = createAnchorAnomalyRule();
    expect(rule.evaluate(ruleContext())).toBeNull();
    expect(rule.evaluate({})).toBeNull();
  });

  it("emits no signal below the minimum anchor transaction count", () => {
    const rule = createAnchorAnomalyRule();
    expect(
      rule.evaluate(
        ruleContext({
          ...NORMAL_CONTEXT,
          anchorTransactionCount: DEFAULT_ANCHOR_ANOMALY_MIN_TRANSACTIONS - 1,
          anchorAmountOutlierCount: 5,
        })
      )
    ).toBeNull();
  });
});

describe("createAnchorAnomalyRule - anomalous anchor activity", () => {
  it("emits a signal for amount outliers with descriptive detail", () => {
    const rule = createAnchorAnomalyRule();
    const signal = rule.evaluate(
      ruleContext({
        ...NORMAL_CONTEXT,
        anchorTransactionCount: 10,
        anchorTotalVolume: 1090,
        anchorAmountMean: 109,
        anchorAmountStdDev: 297,
        anchorAmountMax: 1000,
        anchorAmountMaxShare: 1000 / 1090,
        anchorAmountOutlierCount: 1,
      })
    );

    expect(signal).not.toBeNull();
    expect(signal?.id).toBe("anchor-anomaly");
    expect(signal?.weight).toBeGreaterThan(0);
    expect(signal?.detail ?? "").toMatch(/anchor/i);
    expect(signal?.detail ?? "").toMatch(/outlier/i);
  });

  it("emits a signal for a concentrated amount distribution", () => {
    const rule = createAnchorAnomalyRule();
    const signal = rule.evaluate(
      ruleContext({
        ...NORMAL_CONTEXT,
        anchorTransactionCount: 5,
        anchorTotalVolume: 1040,
        anchorAmountMean: 208,
        anchorAmountStdDev: 396,
        anchorAmountMax: 1000,
        anchorAmountMaxShare: 1000 / 1040,
        anchorAmountOutlierCount: 0,
      })
    );

    expect(signal).not.toBeNull();
    expect(signal?.detail ?? "").toMatch(/volume/i);
  });

  it("emits a signal when most anchor transactions lack a memo", () => {
    const rule = createAnchorAnomalyRule();
    const signal = rule.evaluate(
      ruleContext({
        ...NORMAL_CONTEXT,
        anchorMemoCount: 2,
        anchorMemoMissingCount: 3,
        anchorMemoMaxReuseCount: 1,
        anchorMemoShare: 0.4,
      })
    );

    expect(signal).not.toBeNull();
    expect(signal?.detail ?? "").toMatch(/memo missing/i);
  });

  it("emits a signal when a single memo is replayed across anchor deposits", () => {
    const rule = createAnchorAnomalyRule();
    const signal = rule.evaluate(
      ruleContext({
        ...NORMAL_CONTEXT,
        anchorMemoCount: 5,
        anchorMemoMissingCount: 0,
        anchorMemoDistinctCount: 1,
        anchorMemoMaxReuseCount: 5,
        anchorMemoShare: 1,
      })
    );

    expect(signal).not.toBeNull();
    expect(signal?.detail ?? "").toMatch(/memo reused/i);
  });

  it("scales weight with anomaly severity", () => {
    const rule = createAnchorAnomalyRule();
    const mild = rule.evaluate(
      ruleContext({
        ...NORMAL_CONTEXT,
        anchorAmountMaxShare: 0.85,
        anchorAmountOutlierCount: 1,
      })
    );
    const severe = rule.evaluate(
      ruleContext({
        ...NORMAL_CONTEXT,
        anchorTransactionCount: 12,
        anchorAmountMaxShare: 0.95,
        anchorAmountOutlierCount: 4,
        anchorAmountStdDev: 900,
        anchorAmountMean: 100,
        anchorMemoMissingCount: 6,
        anchorMemoCount: 6,
        anchorMemoShare: 0.5,
        anchorMemoMaxReuseCount: 6,
      })
    );

    expect(mild).not.toBeNull();
    expect(severe).not.toBeNull();
    expect(severe?.weight ?? 0).toBeGreaterThan(mild?.weight ?? 0);
  });
});

describe("createAnchorAnomalyRule - configurable thresholds", () => {
  it("honors a custom minAnchorTransactions", () => {
    const context = ruleContext({
      ...NORMAL_CONTEXT,
      anchorTransactionCount: 2,
      anchorAmountOutlierCount: 2,
      anchorAmountMaxShare: 0.95,
    });

    expect(createAnchorAnomalyRule().evaluate(context)).toBeNull();
    expect(
      createAnchorAnomalyRule({ minAnchorTransactions: 2 }).evaluate(context)
    ).not.toBeNull();
  });

  it("honors a custom missingMemoRatioThreshold", () => {
    const context = ruleContext({
      ...NORMAL_CONTEXT,
      anchorMemoCount: 4,
      anchorMemoMissingCount: 1,
      anchorMemoShare: 0.8,
    });

    expect(createAnchorAnomalyRule().evaluate(context)).toBeNull();
    expect(
      createAnchorAnomalyRule({ missingMemoRatioThreshold: 0.2 }).evaluate(context)
    ).not.toBeNull();
  });

  it("honors a custom memoReuseThreshold", () => {
    const context = ruleContext({
      ...NORMAL_CONTEXT,
      anchorMemoCount: 5,
      anchorMemoMissingCount: 0,
      anchorMemoMaxReuseCount: 2,
      anchorMemoDistinctCount: 4,
      anchorMemoShare: 1,
    });

    expect(createAnchorAnomalyRule().evaluate(context)).toBeNull();
    expect(
      createAnchorAnomalyRule({ memoReuseThreshold: 2 }).evaluate(context)
    ).not.toBeNull();
  });

  it("can silence amount anomalies and memo anomalies independently", () => {
    const amountOnly = ruleContext({
      ...NORMAL_CONTEXT,
      anchorAmountMaxShare: 0.95,
      anchorAmountOutlierCount: 2,
    });
    const memoOnly = ruleContext({
      ...NORMAL_CONTEXT,
      anchorMemoCount: 2,
      anchorMemoMissingCount: 3,
      anchorMemoShare: 0.4,
    });

    expect(
      createAnchorAnomalyRule({ enableMemoAnomalies: false }).evaluate(memoOnly)
    ).toBeNull();
    expect(
      createAnchorAnomalyRule({ enableMemoAnomalies: false }).evaluate(amountOnly)
    ).not.toBeNull();
    expect(
      createAnchorAnomalyRule({ enableAmountAnomalies: false }).evaluate(amountOnly)
    ).toBeNull();
    expect(
      createAnchorAnomalyRule({ enableAmountAnomalies: false }).evaluate(memoOnly)
    ).not.toBeNull();
  });

  it("rejects disabling every anomaly class", () => {
    expect(() =>
      createAnchorAnomalyRule({ enableMemoAnomalies: false, enableAmountAnomalies: false })
    ).toThrow();
  });

  it("rejects invalid options", () => {
    expect(() => createAnchorAnomalyRule({ weight: Number.NaN })).toThrow();
    expect(() => createAnchorAnomalyRule({ minScore: 2 })).toThrow();
    expect(() => createAnchorAnomalyRule({ minScore: -0.1 })).toThrow();
    expect(() => createAnchorAnomalyRule({ minAnchorTransactions: 0 })).toThrow();
    expect(() => createAnchorAnomalyRule({ minAnchorTransactions: 2.5 })).toThrow();
    expect(() => createAnchorAnomalyRule({ missingMemoRatioThreshold: 1.5 })).toThrow();
    expect(() => createAnchorAnomalyRule({ missingMemoRatioThreshold: -0.5 })).toThrow();
    expect(() => createAnchorAnomalyRule({ memoReuseThreshold: 0 })).toThrow();
    expect(() => createAnchorAnomalyRule({ concentrationThreshold: 0 })).toThrow();
    expect(() => createAnchorAnomalyRule({ concentrationThreshold: 1.5 })).toThrow();
    expect(() => createAnchorAnomalyRule({ outlierThreshold: 0 })).toThrow();
    expect(() =>
      createAnchorAnomalyRule({ enableAmountAnomalies: "yes" as unknown as boolean })
    ).toThrow();
  });

  it("uses the documented defaults", () => {
    const rule = createAnchorAnomalyRule();
    expect(rule.id).toBe("anchor-anomaly");
    expect(rule.weight).toBe(DEFAULT_ANCHOR_ANOMALY_RULE_WEIGHT);
    expect(DEFAULT_ANCHOR_ANOMALY_MIN_SCORE).toBe(0.05);
    expect(DEFAULT_ANCHOR_ANOMALY_MIN_TRANSACTIONS).toBe(3);
    expect(DEFAULT_ANCHOR_ANOMALY_MISSING_MEMO_RATIO).toBe(0.5);
    expect(DEFAULT_ANCHOR_ANOMALY_MEMO_REUSE_THRESHOLD).toBe(3);
    expect(DEFAULT_ANCHOR_ANOMALY_CONCENTRATION_THRESHOLD).toBe(0.8);
    expect(DEFAULT_ANCHOR_ANOMALY_OUTLIER_THRESHOLD).toBe(1);
  });
});

describe("createAnchorAnomalyRule - engine composition", () => {
  it("composes through the rules engine with effective weighting", () => {
    const engine: RuleEngine = createRuleEngine({
      rules: [createAnchorAnomalyRule({ weight: 0.6 })],
    });
    const signals = engine.evaluate(
      ruleContext({
        ...NORMAL_CONTEXT,
        anchorTransactionCount: 10,
        anchorAmountMaxShare: 0.95,
        anchorAmountOutlierCount: 2,
      })
    );

    expect(signals).toHaveLength(1);
    expect(signals[0].id).toBe("anchor-anomaly");
    expect(signals[0].weight).toBeGreaterThan(0);
    expect(signals[0].weight).toBeLessThanOrEqual(0.6);
  });
});

let nextId = 0;
function makeTx(overrides: Partial<Transaction> = {}): Transaction {
  nextId += 1;
  return {
    id: `anchor-rule-tx-${nextId}`,
    createdAt: "2026-01-01T12:00:00.000Z",
    sourceAccount: ACCOUNT,
    type: "payment",
    amount: 100,
    assetCode: "USD",
    assetIssuer: ANCHOR_ISSUER,
    pagingToken: String(nextId),
    ...overrides,
  };
}

const ANCHOR_OPTIONS = {
  accountId: ACCOUNT,
  anchorAssetCodes: ["USD"],
} as const;

describe("integration: anchor anomaly features feed the rule", () => {
  it("detects anomalous anchor activity end-to-end", () => {
    const txs = [
      ...Array.from({ length: 9 }, () =>
        makeTx({ amount: 10, memo: `dep-${nextId}`, memoType: "id" })
      ),
      makeTx({ amount: 1000 }),
    ];
    const features = extractAnchorAnomalyFeatures(txs, ANCHOR_OPTIONS);
    const signal = createAnchorAnomalyRule().evaluate(
      anchorAnomalyFeaturesToFeatureMap(features)
    );

    expect(signal).not.toBeNull();
    expect(signal?.id).toBe("anchor-anomaly");
  });

  it("stays quiet for regular anchor activity end-to-end", () => {
    const txs = Array.from({ length: 5 }, (_, index) =>
      makeTx({ amount: 100, memo: `dep-${index}`, memoType: "id" })
    );
    const features = extractAnchorAnomalyFeatures(txs, ANCHOR_OPTIONS);
    const signal = createAnchorAnomalyRule().evaluate(
      anchorAnomalyFeaturesToFeatureMap(features)
    );

    expect(signal).toBeNull();
  });

  it("stays quiet for histories with no anchor activity end-to-end", () => {
    const txs = [
      makeTx({ amount: 1, assetCode: "DOGE", assetIssuer: "GOTHER" }),
      makeTx({ amount: 9999, assetCode: "DOGE", assetIssuer: "GOTHER" }),
    ];
    const features = extractAnchorAnomalyFeatures(txs, ANCHOR_OPTIONS);
    const signal = createAnchorAnomalyRule().evaluate(
      anchorAnomalyFeaturesToFeatureMap(features)
    );

    expect(signal).toBeNull();
  });
});
