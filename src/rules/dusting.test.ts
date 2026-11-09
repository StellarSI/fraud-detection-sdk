/**
 * Tests for the dusting detector rule (issue #28).
 *
 * Acceptance criteria: tiny outbound payments to many recipients emit a
 * signal; legitimate bulk micro-disbursements can be distinguished;
 * thresholds are configurable; and cases cover dusting, legitimate bulk,
 * and normal payments.
 */

import { describe, it, expect } from "vitest";
import type { Transaction } from "../clients/horizon.js";
import { RuleEngine, createRuleEngine } from "./engine.js";
import { DEFAULT_DUSTING_RULE_WEIGHT, createDustingRule } from "./dusting.js";
import {
  extractDustingFeatures,
  dustingFeaturesToFeatureMap,
} from "../features/dusting.js";

const ACCOUNT = "GACCOUNT00000000000000000000000000000000000000000000000000";

function ruleContext(overrides: Record<string, number | boolean> = {}) {
  return {
    dustPaymentCount: 0,
    dustRecipientCount: 0,
    dustTotalVolume: 0,
    dustAverageAmount: 0,
    dustAssetDiversity: 0,
    dustOutboundPaymentCount: 0,
    dustingScore: 0,
    dustThreshold: 0.01,
    ...overrides,
  };
}

let nextId = 0;
function payment(overrides: Partial<Transaction> = {}): Transaction {
  nextId += 1;
  const recipient = overrides.to ?? `GRCPT${String(nextId).padStart(3, "A")}${"0".repeat(45)}`;
  return {
    id: `p-${nextId}`,
    createdAt: "2026-01-01T12:00:00.000Z",
    sourceAccount: ACCOUNT,
    type: "payment",
    amount: 0.0001,
    from: ACCOUNT,
    to: recipient,
    assetCode: "XLM",
    pagingToken: String(nextId),
    ...overrides,
  };
}

function manyDustPayments(count: number, amount: number, opts: { assetCode?: string; assetIssuer?: string } = {}) {
  return Array.from({ length: count }, (_, i) =>
    payment({
      amount,
      to: `GDUST${String(i).padStart(3, "0")}${"A".repeat(48)}`,
      assetCode: opts.assetCode ?? "XLM",
      assetIssuer: opts.assetIssuer,
    })
  );
}

describe("createDustingRule - dusting case", () => {
  it("emits a dusting signal for tiny outbound payments to many recipients", () => {
    const rule = createDustingRule({ recipientCountThreshold: 5, paymentCountThreshold: 5 });
    const signal = rule.evaluate(
      ruleContext({
        dustPaymentCount: 8,
        dustRecipientCount: 8,
        dustTotalVolume: 0.0008,
        dustAverageAmount: 0.0001,
        dustAssetDiversity: 1,
        dustOutboundPaymentCount: 8,
        dustingScore: 0.6,
        dustThreshold: 0.01,
      })
    );

    expect(signal).not.toBeNull();
    expect(signal?.id).toBe("dusting");
    expect(signal?.weight).toBeGreaterThan(0);
    expect(signal?.detail ?? "").toMatch(/dusting/i);
    expect(signal?.detail ?? "").toMatch(/recipient/i);
  });

  it("scales weight with recipient count and amount context", () => {
    const rule = createDustingRule({ recipientCountThreshold: 3, paymentCountThreshold: 3 });

    const mild = rule.evaluate(
      ruleContext({
        dustPaymentCount: 3,
        dustRecipientCount: 3,
        dustTotalVolume: 0.024,
        dustAverageAmount: 0.008,
        dustAssetDiversity: 2,
        dustOutboundPaymentCount: 10,
        dustingScore: 0.2,
      })
    );
    const severe = rule.evaluate(
      ruleContext({
        dustPaymentCount: 20,
        dustRecipientCount: 20,
        dustTotalVolume: 0.002,
        dustAverageAmount: 0.0001,
        dustAssetDiversity: 1,
        dustOutboundPaymentCount: 20,
        dustingScore: 0.9,
      })
    );

    expect(mild).not.toBeNull();
    expect(severe).not.toBeNull();
    expect(severe?.weight ?? 0).toBeGreaterThan(mild?.weight ?? 0);
  });
});

describe("createDustingRule - legitimate bulk micro-disbursements", () => {
  it("distinguishes organized single-asset micro-disbursements using asset and volume context", () => {
    const rule = createDustingRule({
      recipientCountThreshold: 5,
      paymentCountThreshold: 5,
      legitimateMaxAssetDiversity: 1,
      legitimateMinAverageAmount: 0.001,
    });
    // Meaningful micro-disbursement (e.g. NGO payout): same asset, avg above legitimacy floor.
    const signal = rule.evaluate(
      ruleContext({
        dustPaymentCount: 10,
        dustRecipientCount: 10,
        dustTotalVolume: 0.05,
        dustAverageAmount: 0.005,
        dustAssetDiversity: 1,
        dustOutboundPaymentCount: 10,
        dustingScore: 0.7,
      })
    );

    expect(signal).toBeNull();
  });

  it("still flags tiny single-asset spam when average amount is extremely small", () => {
    const rule = createDustingRule({
      recipientCountThreshold: 5,
      paymentCountThreshold: 5,
      legitimateMaxAssetDiversity: 1,
      legitimateMinAverageAmount: 0.001,
    });
    const signal = rule.evaluate(
      ruleContext({
        dustPaymentCount: 10,
        dustRecipientCount: 10,
        dustTotalVolume: 0.001,
        dustAverageAmount: 0.0001,
        dustAssetDiversity: 1,
        dustOutboundPaymentCount: 10,
        dustingScore: 0.7,
      })
    );

    expect(signal).not.toBeNull();
    expect(signal?.id).toBe("dusting");
  });

  it("can distinguish via total volume context when configured", () => {
    const rule = createDustingRule({
      recipientCountThreshold: 5,
      paymentCountThreshold: 5,
      legitimateMaxAssetDiversity: 1,
      legitimateMinAverageAmount: 0,
      legitimateMinTotalVolume: 0.5,
    });
    expect(
      rule.evaluate(
        ruleContext({
          dustPaymentCount: 10,
          dustRecipientCount: 10,
          dustTotalVolume: 1,
          dustAverageAmount: 0.00001,
          dustAssetDiversity: 1,
          dustingScore: 0.7,
        })
      )
    ).toBeNull();
  });
});

describe("createDustingRule - normal payments", () => {
  it("emits no signal when recipient count is below threshold", () => {
    const rule = createDustingRule({ recipientCountThreshold: 5 });
    expect(
      rule.evaluate(
        ruleContext({ dustPaymentCount: 4, dustRecipientCount: 4, dustingScore: 0.2 })
      )
    ).toBeNull();
  });

  it("emits no signal when there is no dusting activity", () => {
    const rule = createDustingRule();
    expect(rule.evaluate(ruleContext())).toBeNull();
    expect(rule.evaluate({})).toBeNull();
  });
});

describe("createDustingRule - configurable thresholds", () => {
  it("honors a custom recipientCountThreshold", () => {
    const context = ruleContext({
      dustPaymentCount: 4,
      dustRecipientCount: 4,
      dustTotalVolume: 0.0004,
      dustAverageAmount: 0.0001,
      dustAssetDiversity: 1,
      dustingScore: 0.4,
    });

    expect(createDustingRule({ recipientCountThreshold: 3, paymentCountThreshold: 3 }).evaluate(context)).not.toBeNull();
    expect(createDustingRule({ recipientCountThreshold: 5 }).evaluate(context)).toBeNull();
  });

  it("honors a custom paymentCountThreshold", () => {
    const context = ruleContext({
      dustPaymentCount: 4,
      dustRecipientCount: 6,
      dustAverageAmount: 0.0001,
      dustAssetDiversity: 1,
      dustingScore: 0.4,
    });
    expect(createDustingRule({ paymentCountThreshold: 3, recipientCountThreshold: 3 }).evaluate(context)).not.toBeNull();
    expect(createDustingRule({ paymentCountThreshold: 5 }).evaluate(context)).toBeNull();
  });

  it("rejects invalid numeric options", () => {
    expect(() => createDustingRule({ weight: Number.NaN })).toThrow();
    expect(() => createDustingRule({ dustThreshold: -1 })).toThrow();
    expect(() => createDustingRule({ legitimateMinAverageAmount: -1 })).toThrow();
  });

  it("uses the default rule weight", () => {
    const rule = createDustingRule();
    expect(rule.id).toBe("dusting");
    expect(rule.weight).toBe(DEFAULT_DUSTING_RULE_WEIGHT);
  });
});

describe("createDustingRule - engine composition", () => {
  it("composes through the rules engine with effective weighting", () => {
    const engine = createRuleEngine({
      rules: [createDustingRule({ weight: 0.5, recipientCountThreshold: 3, paymentCountThreshold: 3 })],
    });
    const signals = engine.evaluate(
      ruleContext({
        dustPaymentCount: 6,
        dustRecipientCount: 6,
        dustTotalVolume: 0.0006,
        dustAverageAmount: 0.0001,
        dustAssetDiversity: 1,
        dustingScore: 1,
      })
    );

    expect(signals).toHaveLength(1);
    expect(signals[0].id).toBe("dusting");
    expect(signals[0].weight).toBeGreaterThan(0);
    expect(signals[0].weight).toBeLessThanOrEqual(0.5);
  });
});

describe("integration: dusting features feed the rule", () => {
  it("detects dusting end-to-end", () => {
    const features = extractDustingFeatures(manyDustPayments(8, 0.0001), {
      accountId: ACCOUNT,
      dustThreshold: 0.01,
    });
    const rule = createDustingRule({ recipientCountThreshold: 5, paymentCountThreshold: 5 });
    const signal = rule.evaluate(dustingFeaturesToFeatureMap(features));
    expect(signal).not.toBeNull();
    expect(signal?.id).toBe("dusting");
  });

  it("distinguishes a legitimate bulk micro-disbursement end-to-end", () => {
    const features = extractDustingFeatures(
      manyDustPayments(8, 0.005, { assetCode: "USDC", assetIssuer: "GISSUER" }),
      { accountId: ACCOUNT, dustThreshold: 0.01 }
    );
    const rule = createDustingRule({
      recipientCountThreshold: 5,
      paymentCountThreshold: 5,
      legitimateMinAverageAmount: 0.001,
    });
    expect(rule.evaluate(dustingFeaturesToFeatureMap(features))).toBeNull();
  });

  it("stays quiet for normal payments end-to-end", () => {
    const features = extractDustingFeatures(
      [
        payment({ amount: 10, to: "GA" }),
        payment({ amount: 20, to: "GB" }),
      ],
      { accountId: ACCOUNT, dustThreshold: 0.01 }
    );
    const rule = createDustingRule();
    expect(rule.evaluate(dustingFeaturesToFeatureMap(features))).toBeNull();
  });
});
