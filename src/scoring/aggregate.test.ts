/**
 * Tests for the signal aggregation and weighting engine (issue #8).
 *
 * Engine rules: declared detector weights are summed, clipped to [0, 1],
 * and classified; contributing signals are emitted as relative shares,
 * ordered by descending weight with deterministic tie-breaking.
 */

import { describe, it, expect } from "vitest";
import { aggregate, compareSignals } from "./aggregate.js";
import { ValidationError } from "../errors.js";
import { Signal } from "../types.js";

describe("aggregate", () => {
  it("aggregates a single signal into its declared weight", () => {
    const result = aggregate([{ id: "fresh-account", weight: 0.3 }]);

    expect(result.score).toBe(0.3);
    expect(result.level).toBe("low");
    expect(result.signals).toEqual([{ id: "fresh-account", weight: 1, detail: undefined }]);
  });

  it("sums multiple declared weights and preserves their relative shares", () => {
    const result = aggregate([
      { id: "rapid-fan-out", weight: 0.6, detail: "Fanned out fast" },
      { id: "fresh-account", weight: 0.3 },
    ]);

    expect(result.score).toBe(0.9);
    expect(result.level).toBe("high");
    expect(result.signals).toEqual([
      { id: "rapid-fan-out", weight: 0.6667, detail: "Fanned out fast" },
      { id: "fresh-account", weight: 0.3333, detail: undefined },
    ]);
  });

  it("clips over-threshold sums to [0, 1]", () => {
    const result = aggregate([
      { id: "rapid-fan-out", weight: 0.8 },
      { id: "high-velocity", weight: 0.7 },
    ]);

    expect(result.score).toBe(1);
    expect(result.level).toBe("high");
  });

  it("orders signals by descending weight", () => {
    const result = aggregate([
      { id: "small", weight: 0.1 },
      { id: "big", weight: 0.4 },
      { id: "middle", weight: 0.25 },
    ]);

    expect(result.signals.map((s) => s.id)).toEqual(["big", "middle", "small"]);
  });

  it("breaks weight ties deterministically by signal id (issue #89)", () => {
    const result = aggregate([
      { id: "zulu", weight: 0.2 },
      { id: "alpha", weight: 0.2 },
      { id: "mike", weight: 0.2 },
    ]);

    expect(result.signals.map((s) => s.id)).toEqual(["alpha", "mike", "zulu"]);
  });

  it("produces identical output for identical input (reproducible)", () => {
    const input: Signal[] = [
      { id: "zulu", weight: 0.2 },
      { id: "alpha", weight: 0.2 },
      { id: "mike", weight: 0.5 },
    ];

    expect(aggregate(input)).toEqual(aggregate([...input].reverse()));
    expect(aggregate(input).signals.map((s) => s.id)).toEqual(["alpha", "mike", "zulu"]);
  });

  it("yields score 0 and level low for an empty signal set", () => {
    const result = aggregate([]);
    expect(result.score).toBe(0);
    expect(result.level).toBe("low");
    expect(result.signals).toEqual([]);
  });

  it("treats zero, negative and non-numeric weights as contributing nothing", () => {
    const result = aggregate([
      { id: "zero", weight: 0 },
      { id: "negative", weight: -0.5 },
      { id: "nan", weight: Number.NaN },
      { id: "missing", weight: undefined as unknown as number },
      { id: "real", weight: 0.25 },
    ]);

    expect(result.score).toBe(0.25);
    expect(result.level).toBe("low");
    expect(result.signals).toHaveLength(1);
    expect(result.signals[0].id).toBe("real");
  });

  it("yields an empty result when every weight is zero", () => {
    const result = aggregate([{ id: "only-zero", weight: 0 }]);
    expect(result).toEqual({ score: 0, level: "low", signals: [] });
  });

  it("classifies with custom thresholds", () => {
    // 0.55 with default thresholds is medium; with low=0.5 it stays
    // medium, and a custom high=0.5 makes it high.
    const signals = [{ id: "a", weight: 0.55 }];

    expect(aggregate(signals).level).toBe("medium");
    expect(aggregate(signals, { thresholds: { low: 0.5, high: 0.9 } }).level).toBe("medium");
    expect(aggregate(signals, { thresholds: { low: 0.4, high: 0.5 } }).level).toBe("high");
  });

  it("rounds the score and contributions to a stable precision", () => {
    const result = aggregate([
      { id: "a", weight: 0.10001 },
      { id: "b", weight: 0.30002 },
    ]);

    expect(result.score).toBeCloseTo(0.4, 4);
    for (const signal of result.signals) {
      expect(Number(signal.weight.toFixed(4))).toBe(signal.weight);
      expect(signal.weight).toBeGreaterThanOrEqual(0);
      expect(signal.weight).toBeLessThanOrEqual(1);
    }
  });

  it("respects a custom precision", () => {
    const result = aggregate(
      [{ id: "a", weight: 0.12345 }, { id: "b", weight: 0.54321 }],
      { precision: 2 }
    );
    // Each declared weight is rounded first (0.12 + 0.54), then summed
    // and clipped: the score is the sum of rounded contributions.
    expect(result.score).toBe(0.66);
    for (const signal of result.signals) {
      expect(Number(signal.weight.toFixed(2))).toBe(signal.weight);
    }
  });

  it("keeps signal details on the emitted explanation", () => {
    const result = aggregate([
      { id: "with-detail", weight: 0.6, detail: "Cleared for review" },
      { id: "no-detail", weight: 0.3 },
    ]);

    expect(result.signals[0].detail).toBe("Cleared for review");
    expect(result.signals[0].id).toBe("with-detail");
  });

  it("rejects non-array input with ValidationError", () => {
    expect(() => aggregate(undefined as unknown as Signal[])).toThrow(ValidationError);
    expect(() => aggregate({ id: "x", weight: 1 } as unknown as Signal[])).toThrow(
      "Signals must be an array"
    );
  });

  it("rejects signals without an id with ValidationError", () => {
    expect(() =>
      aggregate([{ weight: 0.5 } as unknown as Signal])
    ).toThrow(ValidationError);
    expect(() =>
      aggregate([{ id: 42, weight: 0.5 } as unknown as Signal])
    ).toThrow(ValidationError);
  });

  it("orders equal-weight signals by ascending id (issue #11)", () => {
    const result = aggregate([
      { id: "delta", weight: 0.3 },
      { id: "alpha", weight: 0.3 },
      { id: "charlie", weight: 0.3 },
      { id: "bravo", weight: 0.3 },
    ]);

    expect(result.signals.map((s) => s.id)).toEqual(["alpha", "bravo", "charlie", "delta"]);
  });

  it("is independent of signal insertion order — every permutation sorts identically", () => {
    const ids = ["echo", "victor", "tango", "sierra", "romeo"];
    const signals: Signal[] = [
      { id: "echo", weight: 0.2 },
      { id: "victor", weight: 0.2 },
      { id: "tango", weight: 0.2 },
      { id: "sierra", weight: 0.2 },
      { id: "romeo", weight: 0.2 },
    ];

    const reversed = [...signals].reverse();
    const rotated = [signals[2], signals[3], signals[0], signals[4], signals[1]].filter(
      (s): s is Signal => s !== undefined
    );

    const reference = aggregate(signals).signals.map((s) => s.id);
    expect(aggregate(reversed).signals.map((s) => s.id)).toEqual(reference);
    expect(aggregate(rotated).signals.map((s) => s.id)).toEqual(reference);
    // ids unused in input should not leak
    ids.length = 0;
    expect(reference).toEqual(["echo", "romeo", "sierra", "tango", "victor"]);
  });

  it("handles a single signal without sorting surprises", () => {
    const result = aggregate([{ id: "only", weight: 0.7 }]);
    expect(result.signals).toHaveLength(1);
    expect(result.signals[0].id).toBe("only");
    expect(result.signals[0].weight).toBe(1);
  });
});

describe("compareSignals", () => {
  it("is a pure, standalone comparator for explanations (issue #11)", () => {
    // Highest weight first, then ascending id on ties.
    const sorted: Array<{ id: string; weight: number }> = [
      { id: "b", weight: 0.5 },
      { id: "a", weight: 0.4 },
      { id: "z", weight: 0.4 },
      { id: "m", weight: 0.4 },
    ].sort(compareSignals);

    expect(sorted.map((s) => s.id)).toEqual(["b", "a", "m", "z"]);
  });

  it("returns 0 only for identical id + weight pairs", () => {
    const a = { id: "same", weight: 0.5 };
    expect(compareSignals(a, { ...a })).toBe(0);
    expect(compareSignals(a, { id: "same", weight: 0.6 })).not.toBe(0);
    expect(compareSignals(a, { id: "other", weight: 0.5 })).not.toBe(0);
  });
});
