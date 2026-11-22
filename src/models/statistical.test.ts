import { describe, expect, it } from "vitest";
import { StatisticalAnomalyDetector, createStatisticalAnomalyDetector } from "./statistical.js";

describe("StatisticalAnomalyDetector", () => {
  it("emits statistical-anomaly signal naming the driving feature for outliers", () => {
    const detector = createStatisticalAnomalyDetector({ modifiedZThreshold: 3.5, iqrMultiplier: 1.5 });
    const result = detector.evaluate(
      { velocity: 100, amount: 10 },
      {
        velocity: [10, 11, 12, 9, 10, 11, 10, 12],
        amount: [9, 10, 11, 10, 9, 10, 11, 10],
      },
    );

    expect(result.signals.length).toBeGreaterThan(0);
    expect(result.signals[0].id).toBe("statistical-anomaly");
    expect(result.signals[0].detail).toContain("velocity");
    expect(result.signals[0].weight).toBeGreaterThan(0);
  });

  it("handles zero variance and tiny samples gracefully", () => {
    const detector = createStatisticalAnomalyDetector({ minSamples: 4 });
    const noSignal = detector.evaluate({ velocity: 10 }, { velocity: [10, 10, 10, 10] });
    expect(noSignal.signals).toHaveLength(0);

    const zeroVarianceOutlier = detector.evaluate({ velocity: 11 }, { velocity: [10, 10, 10, 10] });
    expect(zeroVarianceOutlier.signals).toHaveLength(1);
    expect(zeroVarianceOutlier.signals[0].detail).toContain("velocity");

    const tinySample = detector.evaluate({ velocity: 100 }, { velocity: [10, 11, 12] });
    expect(tinySample.signals).toHaveLength(0);
  });

  it("supports configurable sensitivity", () => {
    const samples = { velocity: [10, 11, 12, 9, 10, 11, 10, 12] };
    const features = { velocity: 16 };
    const strict = new StatisticalAnomalyDetector({ sensitivity: 0.5 });
    const sensitive = new StatisticalAnomalyDetector({ sensitivity: 2 });

    const strictResult = strict.evaluate(features, samples);
    const sensitiveResult = sensitive.evaluate(features, samples);
    expect(strictResult.signals.length).toBeLessThanOrEqual(sensitiveResult.signals.length);
  });
});
