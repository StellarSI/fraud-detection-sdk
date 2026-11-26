/** Tests for the counterparty-cluster signal rule (issue #44). */

import { describe, expect, it } from "vitest";
import { createCounterpartyClusterRule } from "./counterpartyCluster.js";
import type { RuleContext } from "./engine.js";
import { ValidationError } from "../errors.js";

function context(overrides: RuleContext = {}): RuleContext {
  return {
    clusterId: "cluster:A|B|C",
    clusterSize: 3,
    clusterDensity: 1,
    clusterIsTight: true,
    ...overrides,
  };
}

describe("counterparty-cluster rule", () => {
  it("emits a counterparty-cluster signal for a tight cluster", () => {
    const signals = createCounterpartyClusterRule().evaluate(context());

    expect(signals).not.toBeNull();
    const signal = Array.isArray(signals) ? signals[0] : signals;
    expect(signal?.id).toBe("counterparty-cluster");
    expect(signal?.weight).toBeGreaterThan(0);
    expect(signal?.detail).toMatch(/tight counterparty cluster/);
  });

  it("stays silent for a sparse cluster", () => {
    const signals = createCounterpartyClusterRule().evaluate(
      context({ clusterDensity: 0.4, clusterIsTight: false })
    );

    expect(signals).toBeNull();
  });

  it("stays silent when clustering features are absent", () => {
    expect(createCounterpartyClusterRule().evaluate({})).toBeNull();
  });

  it("respects configured minimums", () => {
    const rule = createCounterpartyClusterRule({
      minSize: 4,
      minDensity: 0.9,
    });
    expect(rule.evaluate(context())).toBeNull();
  });

  it("validates its options", () => {
    expect(() => createCounterpartyClusterRule({ minSize: 0 })).toThrow(
      ValidationError
    );
    expect(() => createCounterpartyClusterRule({ minDensity: 1.5 })).toThrow(
      ValidationError
    );
    expect(() => createCounterpartyClusterRule({ minScore: -0.1 })).toThrow(
      ValidationError
    );
  });
});
