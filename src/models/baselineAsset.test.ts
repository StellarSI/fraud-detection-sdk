import { describe, expect, it } from "vitest";
import { BaselineAsset, InMemoryBaselineStore, createBaselineAssetRule } from "./baselineAsset.js";
import type { RuleContext } from "../rules/engine.js";

const ASSET = "USDC:GISSUER";
const ctx = (overrides: Record<string, number | string> = {}): RuleContext => ({
  asset: ASSET,
  assetVolume: 100,
  velocityTotalCount: 10,
  graphOutDegree: 5,
  ...overrides,
});

describe("BaselineAsset", () => {
  it("stays quiet for normal behavior and emits on deviation", () => {
    const store = new InMemoryBaselineStore();
    const baseline = new BaselineAsset({ store, minObservations: 2, deviationThreshold: 1.5 });
    baseline.record(ASSET, ctx());
    baseline.record(ASSET, ctx());
    expect(baseline.evaluate(ASSET, ctx())).toBeNull();

    const signal = baseline.evaluate(ASSET, ctx({ assetVolume: 1000, velocityTotalCount: 100, graphOutDegree: 50 }));
    expect(signal).not.toBeNull();
    expect(signal?.id).toBe("asset-baseline-deviation");
    expect(signal?.detail).toContain(ASSET);
  });

  it("shares persistence through the store abstraction", () => {
    const store = new InMemoryBaselineStore();
    const baseline = new BaselineAsset({ store });
    baseline.record(ASSET, ctx());
    const snapshot = baseline.getBaseline(ASSET);
    expect(snapshot).toBeTruthy();
  });

  it("rule integrates with rule context", () => {
    const rule = createBaselineAssetRule({ minObservations: 2, deviationThreshold: 1.5 });
    rule.record(ASSET, ctx());
    rule.record(ASSET, ctx());
    expect(rule.evaluate(ctx())).toBeNull();
    expect(rule.evaluate(ctx({ assetVolume: 1000, velocityTotalCount: 100, graphOutDegree: 50 }))).not.toBeNull();
  });
});
