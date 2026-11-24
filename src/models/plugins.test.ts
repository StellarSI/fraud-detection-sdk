/** Conformance tests for every tier's async ModelPlugin adapter (issue #43). */

import { describe, expect, it } from "vitest";
import { ValidationError } from "../errors.js";
import { createRule } from "../rules/engine.js";
import type { ModelContext } from "./types.js";
import {
  createMLModelPlugin,
  createModelPluginRegistry,
  createRulesModelPlugin,
  createStatisticalModelPlugin,
} from "./plugins.js";

const context: ModelContext = {
  transactions: [],
  features: { velocity: 10, flag: true },
};

describe("rules ModelPlugin adapter (issue #43)", () => {
  it("scores asynchronously with signals from the rule engine", async () => {
    const rule = createRule({
      id: "always",
      weight: 1,
      evaluate: () => ({ id: "always", weight: 0.5, detail: "always on" }),
    });
    const plugin = createRulesModelPlugin({ rules: [rule] });
    const result = plugin.score(context);
    expect(result).toBeInstanceOf(Promise);
    await expect(result).resolves.toEqual([{ id: "always", weight: 0.5, detail: "always on" }]);
  });

  it("applies configure() weight and enablement", async () => {
    const rule = createRule({
      id: "always",
      weight: 1,
      evaluate: () => ({ id: "always", weight: 0.5 }),
    });
    const plugin = createRulesModelPlugin({ rules: [rule] });
    plugin.configure({ weight: 0.5 });
    await expect(plugin.score(context)).resolves.toEqual([{ id: "always", weight: 0.25 }]);

    plugin.configure({ enabledRules: { always: false } });
    await expect(plugin.score(context)).resolves.toEqual([]);

    plugin.configure({ enabled: false, enabledRules: { always: true } });
    await expect(plugin.score(context)).resolves.toEqual([]);
  });

  it("rejects invalid configuration", () => {
    const plugin = createRulesModelPlugin({ rules: [] });
    expect(() => plugin.configure({ weight: 2 })).toThrow(ValidationError);
    expect(() => plugin.configure({ enabledRules: { missing: true } })).toThrow();
  });
});

describe("statistical ModelPlugin adapter (issue #43)", () => {
  it("scores asynchronously and emits statistical-anomaly signals", async () => {
    const plugin = createStatisticalModelPlugin({ minSamples: 2 });
    const result = await plugin.score({
      transactions: [],
      features: { velocity: 10 },
      baselineSamples: { velocity: [1, 2, 3, 4] },
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("statistical-anomaly");
    expect(typeof result[0]?.weight).toBe("number");
    expect(result[0]?.detail).toContain("velocity");
  });

  it("returns no signals without baseline samples", async () => {
    const plugin = createStatisticalModelPlugin();
    await expect(plugin.score(context)).resolves.toEqual([]);
  });

  it("supports configure() enablement, weight and sensitivity", async () => {
    const plugin = createStatisticalModelPlugin({ minSamples: 2 });
    plugin.configure({ weight: 0.5, sensitivity: 2 });
    const signals = await plugin.score({
      transactions: [],
      features: { velocity: 10 },
      baselineSamples: { velocity: [1, 2, 3, 4] },
    });
    expect(signals).toHaveLength(1);
    plugin.configure({ enabled: false });
    await expect(plugin.score({ transactions: [] })).resolves.toEqual([]);
  });
});

describe("ML ModelPlugin adapter (issue #43)", () => {
  it("turns a numeric prediction into a weighted, versioned signal", async () => {
    const plugin = createMLModelPlugin({
      id: "stub-ml",
      version: "v1",
      predict: async () => 0.75,
    });
    await expect(plugin.score(context)).resolves.toEqual([
      { id: "stub-ml-prediction", weight: 0.75, detail: "ML model stub-ml@v1 predicted 0.75" },
    ]);
  });

  it("supports sync predictors and configure() threshold/version/weight", async () => {
    const plugin = createMLModelPlugin({ id: "ml", predict: () => 0.6 });
    plugin.configure({ threshold: 0.7 });
    await expect(plugin.score(context)).resolves.toEqual([]);
    plugin.configure({ threshold: 0.5, version: "v2", weight: 0.5 });
    await expect(plugin.score(context)).resolves.toEqual([
      { id: "ml-prediction", weight: 0.3, detail: "ML model ml@v2 predicted 0.6" },
    ]);
  });

  it("rejects invalid predictions and configuration", async () => {
    expect(() => createMLModelPlugin({} as never)).toThrow(ValidationError);
    const plugin = createMLModelPlugin({ id: "bad", predict: () => Number.NaN });
    await expect(plugin.score(context)).rejects.toThrow(ValidationError);
    expect(() => plugin.configure({ version: "" })).toThrow(ValidationError);
  });
});

describe("ModelPluginRegistry (issue #43)", () => {
  it("runs every enabled plugin in registration order", async () => {
    const first = createRulesModelPlugin({
      id: "first",
      rules: [createRule({ id: "r1", weight: 1, evaluate: () => ({ id: "r1", weight: 1 }) })],
    });
    const second = createMLModelPlugin({ id: "second", predict: () => 1 });
    const registry = createModelPluginRegistry([first, second]);

    await expect(registry.score(context)).resolves.toEqual([
      { id: "r1", weight: 1 },
      { id: "second-prediction", weight: 1, detail: "ML model second@unversioned predicted 1" },
    ]);

    registry.setEnabled("first", false);
    expect(registry.isEnabled("first")).toBe(false);
    await expect(registry.score(context)).resolves.toHaveLength(1);
    expect(() => registry.register(first)).toThrow(ValidationError);
  });
});
