/**
 * Tests for the pluggable rules engine (issue #25).
 *
 * Covers common-interface composition into one signal list, per-rule
 * toggling and weight configuration, purity/determinism against synthetic
 * feature contexts, and validation failures.
 */

import { describe, it, expect } from "vitest";
import { aggregate } from "../scoring/aggregate.js";
import { ValidationError } from "../errors.js";
import type { Signal } from "../types.js";
import {
  RuleEngine,
  createDefaultRuleEngine,
  createDefaultRules,
  createRule,
  createRuleEngine,
} from "./engine.js";
import type { Rule, RuleContext } from "./engine.js";

function customRule(overrides: Partial<Rule> = {}): Rule {
  const id = overrides.id ?? "custom";
  return {
    id,
    weight: 0.4,
    evaluate: () => ({ id, weight: 1, detail: "Custom rule fired" }),
    ...overrides,
  };
}

describe("RuleEngine composition", () => {
  it("runs rules implementing the common interface into a single signal list", () => {
    const engine = createRuleEngine({
      rules: [
        customRule({ id: "a", weight: 0.5 }),
        customRule({ id: "b", weight: 0.25 }),
      ],
    });

    const signals = engine.evaluate({});
    expect(signals).toHaveLength(2);
    expect(signals.map((s) => s.id)).toEqual(["a", "b"]);
    expect(signals[0].weight).toBe(0.5);
    expect(signals[1].weight).toBe(0.25);
  });

  it("composes multiple rules into one list and feeds the aggregator (#8)", () => {
    const engine = createDefaultRuleEngine();
    const context: RuleContext = {
      accountAgeMs: 60_000,
      txCount1h: 50,
      graphOutDegree: 9,
      velocityTotalCount: 10,
    };

    const signals = engine.evaluate(context);
    expect(signals.map((s) => s.id)).toEqual(
      expect.arrayContaining(["rapid-fan-out", "high-velocity", "fresh-account"])
    );

    const result = aggregate(signals);
    expect(result.score).toBeGreaterThan(0);
    expect(result.level).toBe("high");
    expect(result.signals.length).toBeGreaterThan(0);
  });

  it("supports rules returning Signal, Signal[], null, and undefined", () => {
    const engine = createRuleEngine({
      rules: [
        customRule({ id: "single", evaluate: () => ({ id: "single", weight: 1 }) }),
        customRule({
          id: "multi",
          evaluate: () => [
            { id: "multi-1", weight: 1 },
            { id: "multi-2", weight: 1 },
          ],
        }),
        customRule({ id: "none-null", evaluate: () => null }),
        customRule({ id: "none-undefined", evaluate: () => undefined }),
      ],
    });

    const signals = engine.evaluate({});
    expect(signals.map((s) => s.id)).toEqual(["single", "multi-1", "multi-2"]);
  });

  it("drops signals with an empty id (the aggregator requires a machine-readable id)", () => {
    const engine = createRuleEngine({
      rules: [
        customRule({ id: "empty", evaluate: () => ({ id: "", weight: 1 }) }),
        customRule({ id: "ok", evaluate: () => ({ id: "ok", weight: 1 }) }),
      ],
    });

    expect(engine.evaluate({}).map((s) => s.id)).toEqual(["ok"]);
  });

  it("is pure and deterministic: identical context yields identical output", () => {
    const engine = createDefaultRuleEngine();
    const context: RuleContext = {
      accountAgeMs: 60_000,
      txCount1h: 50,
      graphOutDegree: 9,
      velocityTotalCount: 10,
    };

    const first = engine.evaluate(context);
    const second = engine.evaluate({ ...context });
    expect(first).toEqual(second);
    expect(engine.run(context)).toEqual(first);
  });
});

describe("RuleEngine enablement and weights", () => {
  it("toggles rules individually via config", () => {
    const engine = createDefaultRuleEngine({
      enabled: { "fresh-account": false },
    });

    expect(engine.isEnabled("fresh-account")).toBe(false);
    expect(engine.isEnabled("high-velocity")).toBe(true);

    const signals = engine.evaluate({ accountAgeMs: 60_000, txCount1h: 50 });
    expect(signals.map((s) => s.id)).not.toContain("fresh-account");
    expect(signals.map((s) => s.id)).toContain("high-velocity");
  });

  it("toggles rules at runtime with setEnabled", () => {
    const engine = createDefaultRuleEngine();
    expect(engine.enabledRules()).toHaveLength(3);

    engine.setEnabled("high-velocity", false);
    expect(engine.isEnabled("high-velocity")).toBe(false);
    expect(engine.enabledRules()).toHaveLength(2);

    const signals = engine.evaluate({ txCount1h: 50 });
    expect(signals.map((s) => s.id)).not.toContain("high-velocity");

    engine.setEnabled("high-velocity", true);
    expect(engine.evaluate({ txCount1h: 50 }).map((s) => s.id)).toContain(
      "high-velocity"
    );
  });

  it("applies a rule's enabled flag by default", () => {
    const engine = createRuleEngine({
      rules: [
        customRule({ id: "on" }),
        customRule({ id: "off", enabled: false }),
      ],
    });

    expect(engine.isEnabled("on")).toBe(true);
    expect(engine.isEnabled("off")).toBe(false);
    expect(engine.evaluate({}).map((s) => s.id)).toEqual(["on"]);
  });

  it("configures weights via config overrides", () => {
    const engine = createRuleEngine({
      rules: [customRule({ id: "tuned", weight: 0.2 })],
      weights: { tuned: 0.8 },
    });

    expect(engine.getWeight("tuned")).toBe(0.8);
    expect(engine.evaluate({})[0].weight).toBe(0.8);
  });

  it("configures weights at runtime with setWeight", () => {
    const engine = createRuleEngine({
      rules: [customRule({ id: "tuned", weight: 0.2 })],
    });

    expect(engine.evaluate({})[0].weight).toBe(0.2);
    engine.setWeight("tuned", 0.7);
    expect(engine.getWeight("tuned")).toBe(0.7);
    expect(engine.evaluate({})[0].weight).toBe(0.7);
  });

  it("scales by the returned signal weight (weight 1 yields the rule weight)", () => {
    const engine = createRuleEngine({
      rules: [
        customRule({
          id: "scaled",
          weight: 0.6,
          evaluate: () => ({ id: "scaled", weight: 0.5 }),
        }),
        customRule({
          id: "unweighted",
          weight: 0.4,
          evaluate: () => ({ id: "unweighted" } as Signal),
        }),
      ],
    });

    const signals = engine.evaluate({});
    expect(signals.find((s) => s.id === "scaled")?.weight).toBe(0.3);
    expect(signals.find((s) => s.id === "unweighted")?.weight).toBe(0.4);
  });

  it("registers and unregisters custom rules", () => {
    const engine = createRuleEngine({ rules: [] });
    expect(engine.listRules()).toHaveLength(0);

    const rule = customRule({ id: "later" });
    expect(engine.register(rule)).toBe(engine);
    expect(engine.hasRule("later")).toBe(true);
    expect(engine.evaluate({}).map((s) => s.id)).toEqual(["later"]);

    expect(engine.unregister("later")).toBe(true);
    expect(engine.evaluate({})).toEqual([]);
  });
});

describe("RuleEngine default rules", () => {
  it("fires fresh-account only for young accounts", () => {
    const engine = createDefaultRuleEngine();

    expect(engine.evaluate({ accountAgeMs: 60_000 }).map((s) => s.id)).toContain(
      "fresh-account"
    );
    expect(
      engine.evaluate({ accountAgeMs: 10 * 86_400_000 }).map((s) => s.id)
    ).not.toContain("fresh-account");
    expect(engine.evaluate({}).map((s) => s.id)).not.toContain("fresh-account");
  });

  it("fires high-velocity only on a burst in the last hour", () => {
    const engine = createDefaultRuleEngine();

    expect(engine.evaluate({ txCount1h: 9 }).map((s) => s.id)).not.toContain(
      "high-velocity"
    );
    expect(engine.evaluate({ txCount1h: 10 }).map((s) => s.id)).toContain(
      "high-velocity"
    );
  });

  it("fires rapid-fan-out only when out-degree dominates the history", () => {
    const engine = createDefaultRuleEngine();

    expect(
      engine.evaluate({ graphOutDegree: 5, velocityTotalCount: 10 }).map((s) => s.id)
    ).not.toContain("rapid-fan-out");
    expect(
      engine.evaluate({ graphOutDegree: 9, velocityTotalCount: 10 }).map((s) => s.id)
    ).toContain("rapid-fan-out");
    expect(
      engine.evaluate({ graphOutDegree: 9, velocityTotalCount: 0 }).map((s) => s.id)
    ).not.toContain("rapid-fan-out");
  });

  it("yields no signals for an empty feature map", () => {
    expect(createDefaultRuleEngine().evaluate({})).toEqual([]);
    expect(createDefaultRules()).toHaveLength(3);
  });
});

describe("RuleEngine validation", () => {
  it("rejects duplicate rule ids", () => {
    const rule = customRule({ id: "dup" });
    expect(() =>
      createRuleEngine({ rules: [rule, { ...rule }] })
    ).toThrow(ValidationError);

    const engine = createRuleEngine({ rules: [rule] });
    expect(() => engine.register({ ...rule })).toThrow(ValidationError);
  });

  it("rejects malformed rules", () => {
    expect(() =>
      createRuleEngine({ rules: [{ weight: 0.5, evaluate: () => null } as never] })
    ).toThrow(ValidationError);
    expect(() =>
      createRuleEngine({ rules: [customRule({ evaluate: null as never })] })
    ).toThrow(ValidationError);
    expect(() => createRule(customRule({ weight: Number.NaN }))).toThrow(
      ValidationError
    );
  });

  it("rejects unknown ids in enabled/weights config", () => {
    expect(() =>
      createDefaultRuleEngine({ enabled: { unknown: true } })
    ).toThrow(/Unknown rule "unknown"/);
    expect(() =>
      createDefaultRuleEngine({ weights: { unknown: 0.5 } })
    ).toThrow(/Unknown rule "unknown"/);
  });

  it("rejects non-boolean enabled values and non-finite weights", () => {
    expect(() =>
      createDefaultRuleEngine({ enabled: { "fresh-account": "no" as never } })
    ).toThrow(ValidationError);
    expect(() =>
      createDefaultRuleEngine({ weights: { "fresh-account": Number.NaN } })
    ).toThrow(ValidationError);
  });

  it("rejects unknown ids and bad weights in setEnabled/setWeight/getWeight", () => {
    const engine = createDefaultRuleEngine();
    expect(() => engine.setEnabled("nope", true)).toThrow(ValidationError);
    expect(() => engine.setEnabled("fresh-account", "x" as never)).toThrow(
      ValidationError
    );
    expect(() => engine.setWeight("nope", 0.5)).toThrow(ValidationError);
    expect(() => engine.setWeight("fresh-account", Number.NaN)).toThrow(
      ValidationError
    );
    expect(() => engine.getWeight("nope")).toThrow(ValidationError);
    expect(() => engine.isEnabled("nope")).toThrow(ValidationError);
  });

  it("rejects a malformed rule context", () => {
    const engine = createDefaultRuleEngine();
    expect(() => engine.evaluate(null as never)).toThrow(ValidationError);
    expect(() => engine.evaluate([] as never)).toThrow(ValidationError);
  });

  it("exposes list/get/has helpers and preserves registration order", () => {
    const engine = createRuleEngine({
      rules: [
        customRule({ id: "z-first" }),
        customRule({ id: "a-second" }),
      ],
    });

    expect(engine.ruleIds()).toEqual(["z-first", "a-second"]);
    expect(engine.listRules()).toHaveLength(2);
    expect(engine.hasRule("z-first")).toBe(true);
    expect(engine.getRule("z-first")?.id).toBe("z-first");
    expect(engine.evaluate({}).map((s) => s.id)).toEqual([
      "z-first",
      "a-second",
    ]);
  });
});
