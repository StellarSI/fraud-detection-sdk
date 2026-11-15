/**
 * Tests for the reused-memo-ID detector rule (issue #33).
 *
 * Acceptance criteria: memo reuse counts are computed from features;
 * reuse beyond the configurable threshold emits a `reused-memo-id`
 * signal; thresholds are configurable; unit tests cover unique,
 * reused, and missing memos.
 */

import { describe, it, expect } from "vitest";
import type { Transaction } from "../clients/horizon.js";
import { RuleEngine, createRuleEngine } from "./engine.js";
import {
  DEFAULT_REUSED_MEMO_ID_RULE_WEIGHT,
  DEFAULT_REUSED_MEMO_ID_REUSE_THRESHOLD,
  createReusedMemoIdRule,
} from "./reusedMemoId.js";
import {
  extractMemoFeatures,
  memoFeaturesToFeatureMap,
} from "../features/memo.js";

const ACCOUNT =
  "GACCOUNT00000000000000000000000000000000000000000000000000";

function ruleContext(overrides: Record<string, number | boolean> = {}) {
  return {
    memoTotalCount: 0,
    memoPresentCount: 0,
    memoAbsentCount: 0,
    memoIdCount: 0,
    memoReusedCount: 0,
    memoMaxReuseCount: 0,
    memoReuseShare: 0,
    memoReusedIdCount: 0,
    memoMaxIdReuseCount: 0,
    ...overrides,
  };
}

let nextId = 0;
function makeTx(overrides: Partial<Transaction> = {}): Transaction {
  nextId += 1;
  return {
    id: `tx-${nextId}`,
    createdAt: "2026-01-01T12:00:00.000Z",
    sourceAccount: ACCOUNT,
    type: "payment",
    amount: 1,
    assetCode: "XLM",
    pagingToken: String(nextId),
    ...overrides,
  };
}

describe("createReusedMemoIdRule - reused memos", () => {
  it("emits a reused-memo-id signal when an id memo repeats", () => {
    const rule = createReusedMemoIdRule();
    const signal = rule.evaluate(
      ruleContext({
        memoPresentCount: 6,
        memoIdCount: 6,
        memoReusedIdCount: 1,
        memoMaxIdReuseCount: 4,
        memoReuseShare: 4 / 6,
      })
    );

    expect(signal).not.toBeNull();
    expect(signal?.id).toBe("reused-memo-id");
    expect(signal?.weight).toBeGreaterThan(0);
    expect(signal?.detail ?? "").toMatch(/reused memo id/i);
    expect(signal?.detail ?? "").toMatch(/4/);
  });

  it("scales weight with reuse count", () => {
    const rule = createReusedMemoIdRule();
    const mild = rule.evaluate(
      ruleContext({
        memoPresentCount: 6,
        memoIdCount: 6,
        memoReusedIdCount: 1,
        memoMaxIdReuseCount: 3,
        memoReuseShare: 0.5,
      })
    );
    const severe = rule.evaluate(
      ruleContext({
        memoPresentCount: 30,
        memoIdCount: 30,
        memoReusedIdCount: 3,
        memoMaxIdReuseCount: 12,
        memoReuseShare: 0.8,
      })
    );

    expect(mild).not.toBeNull();
    expect(severe).not.toBeNull();
    expect(severe?.weight ?? 0).toBeGreaterThan(mild?.weight ?? 0);
  });

  it("does not emit at low reuse below the default threshold", () => {
    const rule = createReusedMemoIdRule();
    expect(
      rule.evaluate(
        ruleContext({
          memoPresentCount: 4,
          memoIdCount: 4,
          memoReusedIdCount: 1,
          memoMaxIdReuseCount: DEFAULT_REUSED_MEMO_ID_REUSE_THRESHOLD - 1,
          memoReuseShare: 0.5,
        })
      )
    ).toBeNull();
  });
});

describe("createReusedMemoIdRule - unique memos", () => {
  it("emits no signal when every memo id is unique", () => {
    const rule = createReusedMemoIdRule();
    expect(
      rule.evaluate(
        ruleContext({
          memoPresentCount: 10,
          memoIdCount: 10,
          memoReusedIdCount: 0,
          memoMaxIdReuseCount: 1,
          memoReuseShare: 0,
        })
      )
    ).toBeNull();
  });
});

describe("createReusedMemoIdRule - missing memos", () => {
  it("emits no signal when no transaction carries a memo", () => {
    const rule = createReusedMemoIdRule();
    expect(rule.evaluate(ruleContext())).toBeNull();
    expect(rule.evaluate({})).toBeNull();
  });

  it("emits no signal when only non-id memos are present but none repeat", () => {
    const rule = createReusedMemoIdRule();
    expect(
      rule.evaluate(
        ruleContext({
          memoPresentCount: 5,
          memoIdCount: 0,
          memoReusedIdCount: 0,
          memoMaxIdReuseCount: 0,
        })
      )
    ).toBeNull();
  });
});

describe("createReusedMemoIdRule - configurable thresholds", () => {
  it("honors a custom reuseThreshold", () => {
    const context = ruleContext({
      memoPresentCount: 4,
      memoIdCount: 4,
      memoReusedIdCount: 1,
      memoMaxIdReuseCount: 2,
      memoReuseShare: 0.5,
    });

    expect(
      createReusedMemoIdRule({ reuseThreshold: 2 }).evaluate(context)
    ).not.toBeNull();
    expect(
      createReusedMemoIdRule({ reuseThreshold: 3 }).evaluate(context)
    ).toBeNull();
  });

  it("rejects invalid options", () => {
    expect(() => createReusedMemoIdRule({ weight: Number.NaN })).toThrow();
    expect(() => createReusedMemoIdRule({ minScore: 2 })).toThrow();
    expect(() => createReusedMemoIdRule({ minScore: -0.1 })).toThrow();
    expect(() => createReusedMemoIdRule({ reuseThreshold: 0 })).toThrow();
    expect(() => createReusedMemoIdRule({ reuseThreshold: 2.5 })).toThrow();
    expect(() => createReusedMemoIdRule({ distinctReuseThreshold: 0 })).toThrow();
  });

  it("uses the default rule weight and reuse threshold", () => {
    const rule = createReusedMemoIdRule();
    expect(rule.id).toBe("reused-memo-id");
    expect(rule.weight).toBe(DEFAULT_REUSED_MEMO_ID_RULE_WEIGHT);
    expect(DEFAULT_REUSED_MEMO_ID_REUSE_THRESHOLD).toBe(3);
  });
});

describe("createReusedMemoIdRule - engine composition", () => {
  it("composes through the rules engine with effective weighting", () => {
    const engine: RuleEngine = createRuleEngine({
      rules: [createReusedMemoIdRule({ weight: 0.5, reuseThreshold: 3 })],
    });
    const signals = engine.evaluate(
      ruleContext({
        memoPresentCount: 15,
        memoIdCount: 15,
        memoReusedIdCount: 1,
        memoMaxIdReuseCount: 9,
        memoReuseShare: 0.6,
      })
    );

    expect(signals).toHaveLength(1);
    expect(signals[0].id).toBe("reused-memo-id");
    expect(signals[0].weight).toBeGreaterThan(0);
    expect(signals[0].weight).toBeLessThanOrEqual(0.5);
  });
});

describe("integration: memo features feed the rule", () => {
  it("detects reused memo ids end-to-end", () => {
    const txs = [
      makeTx({ memo: "12345", memoType: "id" }),
      makeTx({ memo: "12345", memoType: "id" }),
      makeTx({ memo: "12345", memoType: "id" }),
      makeTx({ memo: "12345", memoType: "id" }),
      makeTx({ memo: "99", memoType: "id" }),
    ];
    const features = extractMemoFeatures(txs);
    const rule = createReusedMemoIdRule();
    const signal = rule.evaluate(memoFeaturesToFeatureMap(features));

    expect(signal).not.toBeNull();
    expect(signal?.id).toBe("reused-memo-id");
  });

  it("stays quiet for unique memo ids end-to-end", () => {
    const txs = [
      makeTx({ memo: "101", memoType: "id" }),
      makeTx({ memo: "202", memoType: "id" }),
      makeTx({ memo: "303", memoType: "id" }),
    ];
    const features = extractMemoFeatures(txs);
    const rule = createReusedMemoIdRule();
    expect(rule.evaluate(memoFeaturesToFeatureMap(features))).toBeNull();
  });

  it("stays quiet for missing memos end-to-end", () => {
    const txs = [makeTx(), makeTx({ memo: undefined, memoType: undefined })];
    const features = extractMemoFeatures(txs);
    const rule = createReusedMemoIdRule();
    expect(rule.evaluate(memoFeaturesToFeatureMap(features))).toBeNull();
  });

  it("treats reused leading-zero id memos as the same memo end-to-end", () => {
    const txs = [
      makeTx({ memo: "0012", memoType: "id" }),
      makeTx({ memo: "12", memoType: "id" }),
      makeTx({ memo: "0000012", memoType: "id" }),
    ];
    const features = extractMemoFeatures(txs);
    const rule = createReusedMemoIdRule({ reuseThreshold: 3 });
    expect(rule.evaluate(memoFeaturesToFeatureMap(features))).not.toBeNull();
  });
});
