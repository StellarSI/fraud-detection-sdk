/**
 * Tests for the multisig authorization-change detector rule (issue #35).
 *
 * Acceptance criteria: relevant `set_options` changes are detected;
 * suspicious changes emit a `multisig-authorization` signal with the
 * specific change in the detail; alert rules are configurable per change
 * type; unit tests cover benign and suspicious authorization changes;
 * the rule composes through the rules engine (#25).
 */

import { describe, it, expect } from "vitest";
import type { Transaction } from "../clients/horizon.js";
import { RuleEngine, createRuleEngine } from "./engine.js";
import {
  DEFAULT_MULTISIG_AUTHORIZATION_RULE_WEIGHT,
  DEFAULT_MULTISIG_AUTHORIZATION_MIN_SCORE,
  createMultisigAuthorizationRule,
} from "./multisigAuth.js";
import {
  extractMultisigAuthFeatures,
  multisigAuthFeaturesToFeatureMap,
} from "../features/multisigAuth.js";

const ACCOUNT =
  "GACCOUNT00000000000000000000000000000000000000000000000000";

function ruleContext(overrides: Record<string, number | boolean> = {}) {
  return {
    setOptionsCount: 0,
    signerOperationCount: 0,
    signerAddedCount: 0,
    signerRemovedCount: 0,
    thresholdChangeCount: 0,
    thresholdReductionCount: 0,
    thresholdIncreaseCount: 0,
    masterWeightChangeCount: 0,
    masterWeightReductionCount: 0,
    clawbackEnabledCount: 0,
    clawbackDisabledCount: 0,
    authFlagChangeCount: 0,
    ...overrides,
  };
}

describe("createMultisigAuthorizationRule - suspicious changes", () => {
  it("emits a signal for signer removal", () => {
    const rule = createMultisigAuthorizationRule();
    const signal = rule.evaluate(
      ruleContext({ setOptionsCount: 1, signerRemovedCount: 1 })
    );

    expect(signal).not.toBeNull();
    expect(signal?.id).toBe("multisig-authorization");
    expect(signal?.weight).toBeGreaterThan(0);
    expect(signal?.detail ?? "").toMatch(/signer removal/i);
  });

  it("emits a signal for threshold reduction", () => {
    const rule = createMultisigAuthorizationRule();
    const signal = rule.evaluate(
      ruleContext({
        setOptionsCount: 1,
        thresholdChangeCount: 1,
        thresholdReductionCount: 1,
      })
    );

    expect(signal).not.toBeNull();
    expect(signal?.detail ?? "").toMatch(/threshold reduction/i);
  });

  it("emits a signal for master weight reduction", () => {
    const rule = createMultisigAuthorizationRule();
    const signal = rule.evaluate(
      ruleContext({ setOptionsCount: 1, masterWeightChangeCount: 1, masterWeightReductionCount: 1 })
    );

    expect(signal).not.toBeNull();
    expect(signal?.detail ?? "").toMatch(/master weight/i);
  });

  it("emits a signal for clawback enablement", () => {
    const rule = createMultisigAuthorizationRule();
    const signal = rule.evaluate(
      ruleContext({ setOptionsCount: 1, clawbackEnabledCount: 1 })
    );

    expect(signal).not.toBeNull();
    expect(signal?.detail ?? "").toMatch(/clawback enabled/i);
  });

  it("emits a signal for authorization flag changes", () => {
    const rule = createMultisigAuthorizationRule();
    const signal = rule.evaluate(
      ruleContext({ setOptionsCount: 1, authFlagChangeCount: 1 })
    );

    expect(signal).not.toBeNull();
    expect(signal?.detail ?? "").toMatch(/authorization flag/i);
  });

  it("accumulates severity across multiple suspicious changes", () => {
    const rule = createMultisigAuthorizationRule();
    const mild = rule.evaluate(
      ruleContext({ setOptionsCount: 1, signerRemovedCount: 1 })
    );
    const severe = rule.evaluate(
      ruleContext({
        setOptionsCount: 4,
        signerRemovedCount: 2,
        thresholdChangeCount: 2,
        thresholdReductionCount: 2,
        masterWeightChangeCount: 1,
        masterWeightReductionCount: 1,
        clawbackEnabledCount: 1,
        authFlagChangeCount: 2,
      })
    );

    expect(mild).not.toBeNull();
    expect(severe).not.toBeNull();
    expect(severe?.weight ?? 0).toBeGreaterThan(mild?.weight ?? 0);
  });
});

describe("createMultisigAuthorizationRule - benign changes", () => {
  it("emits no signal with no set_options activity", () => {
    const rule = createMultisigAuthorizationRule();
    expect(rule.evaluate(ruleContext())).toBeNull();
    expect(rule.evaluate({})).toBeNull();
  });

  it("emits no signal for signer additions by default", () => {
    const rule = createMultisigAuthorizationRule();
    expect(
      rule.evaluate(
        ruleContext({ setOptionsCount: 2, signerOperationCount: 2, signerAddedCount: 2 })
      )
    ).toBeNull();
  });

  it("emits no signal for threshold increases by default", () => {
    const rule = createMultisigAuthorizationRule();
    expect(
      rule.evaluate(
        ruleContext({
          setOptionsCount: 1,
          thresholdChangeCount: 1,
          thresholdIncreaseCount: 1,
        })
      )
    ).toBeNull();
  });

  it("emits no signal for clawback disablement by default", () => {
    const rule = createMultisigAuthorizationRule();
    expect(
      rule.evaluate(ruleContext({ setOptionsCount: 1, clawbackDisabledCount: 1 }))
    ).toBeNull();
  });

  it("emits no signal for threshold changes without a known reduction", () => {
    const rule = createMultisigAuthorizationRule();
    expect(
      rule.evaluate(
        ruleContext({ setOptionsCount: 1, thresholdChangeCount: 2 })
      )
    ).toBeNull();
  });
});

describe("createMultisigAuthorizationRule - per change type configuration", () => {
  it("can enable signer addition detection", () => {
    const context = ruleContext({
      setOptionsCount: 1,
      signerOperationCount: 1,
      signerAddedCount: 1,
    });

    expect(createMultisigAuthorizationRule().evaluate(context)).toBeNull();
    expect(
      createMultisigAuthorizationRule({ enableSignerAddition: true }).evaluate(context)
    ).not.toBeNull();
  });

  it("can disable signer removal detection", () => {
    const context = ruleContext({ setOptionsCount: 1, signerRemovedCount: 1 });

    expect(
      createMultisigAuthorizationRule({ enableSignerRemoval: false }).evaluate(context)
    ).toBeNull();
  });

  it("can disable threshold reduction detection", () => {
    const context = ruleContext({
      setOptionsCount: 1,
      thresholdChangeCount: 1,
      thresholdReductionCount: 1,
    });

    expect(
      createMultisigAuthorizationRule({ enableThresholdReduction: false }).evaluate(context)
    ).toBeNull();
  });

  it("can enable threshold increase detection", () => {
    const context = ruleContext({
      setOptionsCount: 1,
      thresholdChangeCount: 1,
      thresholdIncreaseCount: 1,
    });

    expect(
      createMultisigAuthorizationRule({ enableThresholdIncrease: true }).evaluate(context)
    ).not.toBeNull();
  });

  it("can disable clawback enablement detection", () => {
    const context = ruleContext({ setOptionsCount: 1, clawbackEnabledCount: 1 });

    expect(
      createMultisigAuthorizationRule({ enableClawbackEnablement: false }).evaluate(context)
    ).toBeNull();
  });

  it("can enable clawback disable detection", () => {
    const context = ruleContext({ setOptionsCount: 1, clawbackDisabledCount: 1 });

    expect(
      createMultisigAuthorizationRule({ enableClawbackDisable: true }).evaluate(context)
    ).not.toBeNull();
  });

  it("can disable authorization flag change detection", () => {
    const context = ruleContext({ setOptionsCount: 1, authFlagChangeCount: 1 });

    expect(
      createMultisigAuthorizationRule({ enableAuthFlagChange: false }).evaluate(context)
    ).toBeNull();
  });

  it("rejects disabling every change type", () => {
    expect(() =>
      createMultisigAuthorizationRule({
        enableSignerRemoval: false,
        enableSignerAddition: false,
        enableThresholdReduction: false,
        enableThresholdIncrease: false,
        enableMasterWeightReduction: false,
        enableClawbackEnablement: false,
        enableClawbackDisable: false,
        enableAuthFlagChange: false,
      })
    ).toThrow();
  });

  it("rejects invalid options", () => {
    expect(() => createMultisigAuthorizationRule({ weight: Number.NaN })).toThrow();
    expect(() => createMultisigAuthorizationRule({ minScore: 2 })).toThrow();
    expect(() => createMultisigAuthorizationRule({ minScore: -0.1 })).toThrow();
    expect(() =>
      createMultisigAuthorizationRule({
        enableSignerRemoval: "yes" as unknown as boolean,
      })
    ).toThrow();
  });

  it("uses the documented defaults", () => {
    const rule = createMultisigAuthorizationRule();
    expect(rule.id).toBe("multisig-authorization");
    expect(rule.weight).toBe(DEFAULT_MULTISIG_AUTHORIZATION_RULE_WEIGHT);
    expect(DEFAULT_MULTISIG_AUTHORIZATION_MIN_SCORE).toBe(0.05);
  });
});

describe("createMultisigAuthorizationRule - engine composition", () => {
  it("composes through the rules engine with effective weighting", () => {
    const engine: RuleEngine = createRuleEngine({
      rules: [createMultisigAuthorizationRule({ weight: 0.6 })],
    });
    const signals = engine.evaluate(
      ruleContext({ setOptionsCount: 1, signerRemovedCount: 1, clawbackEnabledCount: 1 })
    );

    expect(signals).toHaveLength(1);
    expect(signals[0].id).toBe("multisig-authorization");
    expect(signals[0].weight).toBeGreaterThan(0);
    expect(signals[0].weight).toBeLessThanOrEqual(0.6);
  });
});

let nextId = 0;
function makeTx(overrides: Partial<Transaction> = {}): Transaction {
  nextId += 1;
  return {
    id: `multisig-rule-tx-${nextId}`,
    createdAt: "2026-01-01T12:00:00.000Z",
    sourceAccount: ACCOUNT,
    type: "set_options",
    amount: 0,
    assetCode: "XLM",
    pagingToken: String(nextId),
    ...overrides,
  };
}

describe("integration: multisig features feed the rule", () => {
  it("detects suspicious authorization changes end-to-end", () => {
    const txs = [
      makeTx({
        setOptions: {
          signers: [{ key: "GSIGNER", weight: 0 }],
          thresholds: { low: 0, medium: 1, high: 1 },
          previousThresholds: { low: 1, medium: 2, high: 3 },
        },
      }),
      makeTx({ setOptions: { setFlags: ["clawback_enabled"] } }),
    ];
    const features = extractMultisigAuthFeatures(txs);
    const signal = createMultisigAuthorizationRule().evaluate(
      multisigAuthFeaturesToFeatureMap(features)
    );

    expect(signal).not.toBeNull();
    expect(signal?.id).toBe("multisig-authorization");
    expect(signal?.detail ?? "").toMatch(/signer removal/i);
    expect(signal?.detail ?? "").toMatch(/clawback/i);
  });

  it("stays quiet for benign authorization changes end-to-end", () => {
    const txs = [
      makeTx({
        setOptions: {
          signers: [{ key: "GSIGNER", weight: 3 }],
          thresholds: { low: 1, medium: 2, high: 3 },
          previousThresholds: { low: 0, medium: 1, high: 2 },
        },
      }),
    ];
    const features = extractMultisigAuthFeatures(txs);
    const signal = createMultisigAuthorizationRule().evaluate(
      multisigAuthFeaturesToFeatureMap(features)
    );

    expect(signal).toBeNull();
  });
});
