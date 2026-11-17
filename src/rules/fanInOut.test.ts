/**
 * Tests for the rapid fan-in / fan-out detector rule (issue #37).
 *
 * Acceptance criteria: fan-in and fan-out are distinguished; bursts inside
 * a small window emit `fan-in`/`fan-out` signals scaled by count and speed;
 * thresholds are configurable; steady activity stays quiet; the rule
 * composes through the rules engine (#25).
 */

import { describe, it, expect } from "vitest";
import type { Transaction } from "../clients/horizon.js";
import { ValidationError } from "../errors.js";
import { createRuleEngine } from "./engine.js";
import {
  DEFAULT_FAN_IN_OUT_RULE_WEIGHT,
  DEFAULT_FAN_IN_OUT_MIN_SCORE,
  createFanInOutRule,
} from "./fanInOut.js";
import {
  extractFanInOutFeatures,
  fanInOutFeaturesToFeatureMap,
} from "../features/fanInOut.js";

const ACCOUNT = "GACCOUNT00000000000000000000000000000000000000000000000000";

function ruleContext(overrides: Record<string, number> = {}) {
  return {
    fanInDegree: 0,
    fanOutDegree: 0,
    fanInBurstCount: 0,
    fanOutBurstCount: 0,
    fanPeakInPerLedger: 0,
    fanPeakOutPerLedger: 0,
    fanBurstLedgers: 3,
    ...overrides,
  };
}

function tx(overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: "tx",
    createdAt: "2026-01-01T12:00:00.000Z",
    sourceAccount: ACCOUNT,
    type: "payment",
    amount: 10,
    assetCode: "XLM",
    from: ACCOUNT,
    to: ACCOUNT,
    ledger: 100,
    pagingToken: "1",
    ...overrides,
  };
}

describe("createFanInOutRule - bursts", () => {
  it("emits a fan-in signal for many senders", () => {
    const rule = createFanInOutRule();
    const signals = rule.evaluate(
      ruleContext({
        fanInDegree: 12,
        fanInBurstCount: 8,
        fanPeakInPerLedger: 4,
      })
    );
    expect(signals).not.toBeNull();
    expect(signals).toHaveLength(1);
    expect(signals?.[0]?.id).toBe("fan-in");
    expect(signals?.[0]?.weight).toBeGreaterThan(0);
    expect(signals?.[0]?.detail ?? "").toMatch(/fan-in/i);
    expect(signals?.[0]?.detail ?? "").toMatch(/per ledger/i);
  });

  it("emits a fan-out signal for many recipients", () => {
    const rule = createFanInOutRule();
    const signals = rule.evaluate(
      ruleContext({
        fanOutDegree: 12,
        fanOutBurstCount: 8,
        fanPeakOutPerLedger: 4,
      })
    );
    expect(signals).toHaveLength(1);
    expect(signals?.[0]?.id).toBe("fan-out");
    expect(signals?.[0]?.detail ?? "").toMatch(/fan-out/i);
  });

  it("distinguishes and returns both directions", () => {
    const rule = createFanInOutRule();
    const signals = rule.evaluate(
      ruleContext({
        fanInDegree: 12,
        fanInBurstCount: 8,
        fanPeakInPerLedger: 4,
        fanOutDegree: 11,
        fanOutBurstCount: 6,
        fanPeakOutPerLedger: 3,
      })
    );
    expect(signals?.map((signal) => signal.id)).toEqual(["fan-in", "fan-out"]);
  });

  it("flags bursts by speed even with a modest window-wide degree", () => {
    const rule = createFanInOutRule({
      degreeThreshold: 100,
      speedThreshold: 3,
    });
    const signals = rule.evaluate(
      ruleContext({ fanInDegree: 6, fanPeakInPerLedger: 4 })
    );
    expect(signals?.[0]?.id).toBe("fan-in");
  });

  it("scales severity with count and speed", () => {
    const rule = createFanInOutRule();
    const mild = rule.evaluate(ruleContext({ fanInDegree: 10 }));
    const severe = rule.evaluate(
      ruleContext({
        fanInDegree: 20,
        fanInBurstCount: 10,
        fanPeakInPerLedger: 5,
      })
    );
    expect(severe?.[0]?.weight ?? 0).toBeGreaterThan(mild?.[0]?.weight ?? 0);
  });
});

describe("createFanInOutRule - steady activity", () => {
  it("emits nothing for an empty context", () => {
    const rule = createFanInOutRule();
    expect(rule.evaluate({})).toBeNull();
  });

  it("stays quiet for steady, low-volume activity", () => {
    const rule = createFanInOutRule();
    expect(
      rule.evaluate(
        ruleContext({
          fanInDegree: 3,
          fanInBurstCount: 1,
          fanPeakInPerLedger: 1,
          fanOutDegree: 2,
          fanOutBurstCount: 1,
          fanPeakOutPerLedger: 1,
        })
      )
    ).toBeNull();
  });
});

describe("createFanInOutRule - configuration", () => {
  it("honors custom thresholds", () => {
    const sensitive = createFanInOutRule({
      degreeThreshold: 3,
      burstThreshold: 2,
      speedThreshold: 2,
    });
    expect(
      sensitive.evaluate(ruleContext({ fanOutDegree: 4, fanOutBurstCount: 2 }))
    ).not.toBeNull();

    const strict = createFanInOutRule({ degreeThreshold: 1000, speedThreshold: 100 });
    expect(
      strict.evaluate(ruleContext({ fanOutDegree: 4, fanOutBurstCount: 2 }))
    ).toBeNull();
  });

  it("can evaluate one direction only", () => {
    const fanOutOnly = createFanInOutRule({ enableFanIn: false });
    const signals = fanOutOnly.evaluate(
      ruleContext({
        fanInDegree: 20,
        fanInBurstCount: 10,
        fanOutDegree: 12,
        fanOutBurstCount: 6,
      })
    );
    expect(signals?.map((signal) => signal.id)).toEqual(["fan-out"]);
  });

  it("validates option values", () => {
    expect(() => createFanInOutRule({ weight: Number.NaN })).toThrow(
      ValidationError
    );
    expect(() => createFanInOutRule({ minScore: -0.1 })).toThrow(ValidationError);
    expect(() => createFanInOutRule({ degreeThreshold: 0 })).toThrow(
      ValidationError
    );
    expect(() => createFanInOutRule({ speedThreshold: 1.5 })).toThrow(
      ValidationError
    );
    expect(() =>
      createFanInOutRule({ enableFanIn: false, enableFanOut: false })
    ).toThrow(ValidationError);
  });

  it("exposes documented defaults", () => {
    expect(DEFAULT_FAN_IN_OUT_RULE_WEIGHT).toBe(0.6);
    expect(DEFAULT_FAN_IN_OUT_MIN_SCORE).toBe(0.05);
  });
});

describe("fan-in/out rule integration", () => {
  it("composes with the rules engine and the feature extractor", () => {
    const transactions: Transaction[] = [];
    for (let index = 0; index < 12; index += 1) {
      transactions.push(
        tx({ id: `in-${index}`, from: `SENDER${index}`, to: ACCOUNT, ledger: 100 + index })
      );
    }
    const features = fanInOutFeaturesToFeatureMap(
      extractFanInOutFeatures(transactions, {
        accountId: ACCOUNT,
        now: "2026-01-01T12:00:00.000Z",
      })
    );
    const engine = createRuleEngine({ rules: [createFanInOutRule()] });
    const signals = engine.evaluate(features);
    expect(signals.map((signal) => signal.id)).toContain("fan-in");
    expect(signals[0]?.weight).toBeGreaterThan(0);
  });
});
