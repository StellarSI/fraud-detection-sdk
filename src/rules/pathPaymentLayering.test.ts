/**
 * Tests for the path-payment layering detector rule (issue #26).
 *
 * Acceptance criteria: path payment operations are identified and parsed,
 * long-chained and circular paths emit a signal, signal weight scales
 * with severity, and cases cover simple, long, circular, and no-path.
 */

import { describe, it, expect } from "vitest";
import type { Transaction } from "../clients/horizon.js";
import { RuleEngine, createRuleEngine } from "./engine.js";
import { createPathPaymentLayeringRule } from "./pathPaymentLayering.js";
import {
  extractPathPaymentLayeringFeatures,
  pathPaymentLayeringFeaturesToFeatureMap,
} from "../features/pathPaymentLayering.js";

function ruleContext(overrides: Record<string, number | boolean> = {}) {
  return {
    pathPaymentCount: 0,
    pathPaymentMaxHops: 0,
    pathPaymentLongChainCount: 0,
    pathPaymentCircularCount: 0,
    pathPaymentRapidCount: 0,
    pathPaymentHasCircularFlow: false,
    pathPaymentLayeringScore: 0,
    ...overrides,
  };
}

let nextId = 0;
function tx(overrides: Partial<Transaction> & { path?: Transaction["path"] } = {}): Transaction {
  nextId += 1;
  return {
    id: `pp-${nextId}`,
    createdAt: "2026-01-01T12:00:00.000Z",
    sourceAccount: "GA",
    type: "payment",
    amount: 10,
    assetCode: "XLM",
    from: "GA",
    to: "GB",
    pagingToken: String(nextId),
    ...overrides,
  };
}

describe("createPathPaymentLayeringRule - no-path case", () => {
  it("emits no signal when no path payments are present", () => {
    const rule = createPathPaymentLayeringRule();
    expect(rule.evaluate(ruleContext())).toBeNull();
    expect(rule.evaluate({})).toBeNull();
  });
});

describe("createPathPaymentLayeringRule - simple case", () => {
  it("emits a path-payment-layering signal for path payment activity", () => {
    const rule = createPathPaymentLayeringRule({ weight: 0.7 });
    const signal = rule.evaluate(
      ruleContext({
        pathPaymentCount: 1,
        pathPaymentMaxHops: 1,
        pathPaymentLayeringScore: 0.2,
      })
    );
    expect(signal).not.toBeNull();
    expect(signal?.id).toBe("path-payment-layering");
    expect(signal?.weight).toBeGreaterThan(0);
  });
});

describe("createPathPaymentLayeringRule - long chains", () => {
  it("emits a stronger signal for long hop chains", () => {
    const rule = createPathPaymentLayeringRule({ weight: 0.7 });
    const shortSignal = rule.evaluate(
      ruleContext({
        pathPaymentCount: 1,
        pathPaymentMaxHops: 1,
        pathPaymentLayeringScore: 0.1,
      })
    );
    const longSignal = rule.evaluate(
      ruleContext({
        pathPaymentCount: 1,
        pathPaymentMaxHops: 5,
        pathPaymentLongChainCount: 1,
        pathPaymentLayeringScore: 0.6,
      })
    );
    expect(shortSignal).not.toBeNull();
    expect(longSignal).not.toBeNull();
    expect((longSignal?.weight ?? 0)).toBeGreaterThan(shortSignal?.weight ?? 0);
  });
});

describe("createPathPaymentLayeringRule - circular case", () => {
  it("emits a signal when circular paths or flows are detected", () => {
    const rule = createPathPaymentLayeringRule({ weight: 0.7 });
    const signal = rule.evaluate(
      ruleContext({
        pathPaymentCount: 2,
        pathPaymentMaxHops: 2,
        pathPaymentCircularCount: 1,
        pathPaymentHasCircularFlow: true,
        pathPaymentLayeringScore: 0.5,
      })
    );
    expect(signal).not.toBeNull();
    expect(signal?.id).toBe("path-payment-layering");
    expect(signal?.detail ?? "").toMatch(/circular/i);
  });
});

describe("createPathPaymentLayeringRule - scaling", () => {
  it("scales weight with hop count and frequency", () => {
    const rule = createPathPaymentLayeringRule({ weight: 0.7 });
    const low = rule.evaluate(
      ruleContext({
        pathPaymentCount: 1,
        pathPaymentMaxHops: 1,
        pathPaymentLayeringScore: 0.15,
      })
    );
    const highFreq = rule.evaluate(
      ruleContext({
        pathPaymentCount: 8,
        pathPaymentMaxHops: 4,
        pathPaymentRapidCount: 6,
        pathPaymentLongChainCount: 4,
        pathPaymentLayeringScore: 0.8,
      })
    );
    expect((highFreq?.weight ?? 0)).toBeGreaterThan(low?.weight ?? 0);
  });

  it("composes through the rules engine with effective weighting", () => {
    const engine = createRuleEngine({
      rules: [createPathPaymentLayeringRule({ weight: 0.5 })],
    });
    const signals = engine.evaluate(
      ruleContext({
        pathPaymentCount: 1,
        pathPaymentMaxHops: 4,
        pathPaymentLongChainCount: 1,
        pathPaymentLayeringScore: 1,
      })
    );
    expect(signals).toHaveLength(1);
    expect(signals[0].id).toBe("path-payment-layering");
    expect(signals[0].weight).toBeGreaterThan(0);
    expect(signals[0].weight).toBeLessThanOrEqual(0.5);
  });
});

describe("integration: features feed the rule", () => {
  it("detects long, circular, and rapid path payments end-to-end", () => {
    const features = extractPathPaymentLayeringFeatures(
      [
        tx({
          type: "path_payment_strict_send",
          from: "GA",
          to: "GB",
          createdAt: "2026-01-01T11:50:00.000Z",
          path: [
            { asset_code: "USD", asset_issuer: "I1" },
            { asset_code: "EUR", asset_issuer: "I2" },
            { asset_code: "USD", asset_issuer: "I1" },
          ],
        }),
        tx({
          type: "path_payment_strict_receive",
          from: "GB",
          to: "GA",
          createdAt: "2026-01-01T11:55:00.000Z",
          path: [
            { asset_code: "USD", asset_issuer: "I1" },
            { asset_code: "JPY", asset_issuer: "I3" },
          ],
        }),
      ],
      { now: "2026-01-01T12:00:00.000Z" }
    );

    const rule = createPathPaymentLayeringRule({ weight: 0.7 });
    const signal = rule.evaluate(pathPaymentLayeringFeaturesToFeatureMap(features));
    expect(signal).not.toBeNull();
    expect(signal?.id).toBe("path-payment-layering");
  });
});
