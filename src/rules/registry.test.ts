/**
 * Tests for the pluggable rule registry (issue #38).
 *
 * Acceptance criteria: all detectors from #26-#37 are registered;
 * rules can be enabled/disabled and re-weighted; the active rule list
 * is introspectable; new rules can be added without engine changes.
 */

import { describe, expect, it } from "vitest";
import type { Rule, RuleContext } from "./engine.js";
import type { Signal } from "../types.js";
import {
  createRuleRegistry,
  createDefaultRuleRegistry,
  type RuleRegistry,
} from "./registry.js";
import { createReusedMemoIdRule } from "./reusedMemoId.js";

function ruleContext(overrides: Record<string, number | boolean> = {}): RuleContext {
  return {
    memoPresentCount: 0,
    memoIdCount: 0,
    memoReusedIdCount: 0,
    memoMaxIdReuseCount: 0,
    memoReuseShare: 0,
    ...overrides,
  };
}

function testRule(id: string): Rule {
  return {
    id,
    weight: 0.5,
    evaluate(context: RuleContext): Signal | null {
      const value = context[`${id}-value`];
      if (typeof value === "number" && value > 0) {
        return { id, weight: 1, detail: `${id} signal` };
      }
      return null;
    },
  };
}

describe("RuleRegistry - registration", () => {
  it("starts empty when no rules are supplied", () => {
    const registry: RuleRegistry = createRuleRegistry({ rules: [] });

    expect(registry.ruleIds()).toEqual([]);
    expect(registry.listRules()).toEqual([]);
  });

  it("registers rules and tracks them in insertion order", () => {
    const registry: RuleRegistry = createRuleRegistry({ rules: [] });
    registry.register(testRule("alpha"));
    registry.register(testRule("beta"));

    expect(registry.ruleIds()).toEqual(["alpha", "beta"]);
    expect(registry.listRules().map((rule) => rule.id)).toEqual(["alpha", "beta"]);
    expect(registry.hasRule("alpha")).toBe(true);
    expect(registry.hasRule("gamma")).toBe(false);
  });

  it("rejects duplicate rule ids", () => {
    const registry: RuleRegistry = createRuleRegistry({ rules: [] });
    registry.register(testRule("alpha"));

    expect(() => registry.register(testRule("alpha"))).toThrow(
      'Duplicate rule "alpha"'
    );
  });

  it("getRule returns undefined for unknown ids", () => {
    const registry: RuleRegistry = createRuleRegistry({ rules: [] });

    expect(registry.getRule("nope")).toBeUndefined();
  });

  it("unregisters rules", () => {
    const registry: RuleRegistry = createRuleRegistry({ rules: [] });
    registry.register(testRule("alpha"));
    registry.register(testRule("beta"));

    expect(registry.unregister("alpha")).toBe(true);
    expect(registry.hasRule("alpha")).toBe(false);
    expect(registry.unregister("alpha")).toBe(false);
    expect(registry.ruleIds()).toEqual(["beta"]);
  });

  it("rejects unknown ids in enabled config", () => {
    expect(() =>
      createRuleRegistry({ rules: [testRule("alpha")], enabled: { nope: true } })
    ).toThrow(/Unknown rule "nope" in enabled config/);
  });

  it("rejects unknown ids in weights config", () => {
    expect(() =>
      createRuleRegistry({ rules: [testRule("alpha")], weights: { nope: 0.5 } })
    ).toThrow(/Unknown rule "nope" in weights config/);
  });
});

describe("RuleRegistry - enablement and weights", () => {
  it("enables rules by default", () => {
    const registry: RuleRegistry = createRuleRegistry({ rules: [testRule("alpha")] });

    expect(registry.isEnabled("alpha")).toBe(true);
  });

  it("honors the enabled option map", () => {
    const registry: RuleRegistry = createRuleRegistry({
      rules: [testRule("alpha"), testRule("beta")],
      enabled: { alpha: false, beta: true },
    });

    expect(registry.isEnabled("alpha")).toBe(false);
    expect(registry.isEnabled("beta")).toBe(true);
  });

  it("toggles enablement at runtime", () => {
    const registry: RuleRegistry = createRuleRegistry({ rules: [testRule("alpha")] });

    registry.setEnabled("alpha", false);
    expect(registry.isEnabled("alpha")).toBe(false);
    registry.setEnabled("alpha", true);
    expect(registry.isEnabled("alpha")).toBe(true);
  });

  it("rejects non-boolean enablement", () => {
    const registry: RuleRegistry = createRuleRegistry({ rules: [testRule("alpha")] });

    expect(() => registry.setEnabled("alpha", "yes" as unknown as boolean)).toThrow();
  });

  it("applies weight overrides", () => {
    const registry: RuleRegistry = createRuleRegistry({
      rules: [testRule("alpha"), testRule("beta")],
      weights: { alpha: 0.9 },
    });

    expect(registry.getWeight("alpha")).toBe(0.9);
    expect(registry.getWeight("beta")).toBe(0.5);
  });

  it("overrides weights at runtime", () => {
    const registry: RuleRegistry = createRuleRegistry({ rules: [testRule("alpha")] });

    registry.setWeight("alpha", 0.25);
    expect(registry.getWeight("alpha")).toBe(0.25);
  });

  it("rejects unknown ids in setWeight", () => {
    const registry: RuleRegistry = createRuleRegistry({ rules: [testRule("alpha")] });

    expect(() => registry.setWeight("nope", 0.5)).toThrow(/Unknown rule "nope"/);
  });

  it("rejects non-finite weights", () => {
    const registry: RuleRegistry = createRuleRegistry({ rules: [testRule("alpha")] });

    expect(() => registry.setWeight("alpha", Number.NaN)).toThrow();
  });
});

describe("RuleRegistry - evaluation", () => {
  it("emits signals only for enabled rules", () => {
    const registry: RuleRegistry = createRuleRegistry({
      rules: [testRule("alpha"), testRule("beta")],
      enabled: { alpha: true, beta: false },
    });

    const signals = registry.evaluate({
      "alpha-value": 5,
      "beta-value": 5,
    } as RuleContext);

    expect(signals).toHaveLength(1);
    expect(signals[0].id).toBe("alpha");
  });

  it("applies weight overrides to effective signal weight", () => {
    const registry: RuleRegistry = createRuleRegistry({
      rules: [testRule("alpha")],
      weights: { alpha: 0.2 },
    });

    const signals = registry.evaluate({ "alpha-value": 5 } as RuleContext);

    expect(signals).toHaveLength(1);
    expect(signals[0].id).toBe("alpha");
    expect(signals[0].weight).toBeGreaterThan(0);
    expect(signals[0].weight).toBeLessThanOrEqual(0.2);
  });

  it("returns signals for every rule in the default registry", () => {
    const registry: RuleRegistry = createDefaultRuleRegistry();

    const signals = registry.evaluate({} as RuleContext);

    // With empty feature context every detector stays quiet.
    expect(signals).toEqual([]);
  });
});

describe("RuleRegistry - snapshot", () => {
  it("reports every rule's id, enabled state and weight", () => {
    const registry: RuleRegistry = createRuleRegistry({
      rules: [testRule("alpha"), testRule("beta")],
      enabled: { alpha: false },
      weights: { beta: 0.7 },
    });

    const snapshot: RuleRegistrySnapshot = registry.snapshot();

    expect(snapshot.rules).toEqual([
      { id: "alpha", enabled: false, weight: 0.5 },
      { id: "beta", enabled: true, weight: 0.7 },
    ]);
  });

  it("reflects runtime changes", () => {
    const registry: RuleRegistry = createRuleRegistry({ rules: [testRule("alpha")] });

    registry.setEnabled("alpha", false);
    registry.setWeight("alpha", 0.125);

    const snapshot = registry.snapshot();
    expect(snapshot.rules).toEqual([{ id: "alpha", enabled: false, weight: 0.125 }]);
  });
});

describe("createDefaultRuleRegistry", () => {
  it("registers every detector rule (#26-#37)", () => {
    const registry: RuleRegistry = createDefaultRuleRegistry();

    const ids = registry.ruleIds();

    expect(ids).toContain("path-payment-layering");
    expect(ids).toContain("trustline-abuse");
    expect(ids).toContain("throwaway-account");
    expect(ids).toContain("dusting");
    expect(ids).toContain("create-account-funding");
    expect(ids).toContain("claimable-balance-abuse");
    expect(ids).toContain("unsolicited-claim-spam");
    expect(ids).toContain("reused-memo-id");
    expect(ids).toContain("anchor-anomaly");
    expect(ids).toContain("multisig-authorization");
    expect(ids).toContain("clawback-activity");
    expect(ids).toContain("fan-in-out");
    expect(ids).toHaveLength(12);
  });

  it("composes a real detector through the engine", () => {
    const registry: RuleRegistry = createDefaultRuleRegistry();

    const signals = registry.evaluate(
      ruleContext({
        memoPresentCount: 6,
        memoIdCount: 6,
        memoReusedIdCount: 1,
        memoMaxIdReuseCount: 4,
        memoReuseShare: 4 / 6,
      })
    );

    expect(signals).toHaveLength(1);
    expect(signals[0].id).toBe("reused-memo-id");
    expect(signals[0].weight).toBeGreaterThan(0);
  });
});
