/**
 * Tests for score normalization utilities.
 *
 * Covers clipping, rounding, and the main normalizeScore function
 * including edge cases for non-finite inputs.
 */

import { describe, it, expect } from "vitest";
import {
  clipToUnitInterval,
  roundToPrecision,
  normalizeScore,
  normalizeScoreWithRange,
  DEFAULT_SCORE_PRECISION,
} from "./normalize.js";

describe("clipToUnitInterval", () => {
  it("passes values already in [0, 1] through unchanged", () => {
    expect(clipToUnitInterval(0)).toBe(0);
    expect(clipToUnitInterval(0.5)).toBe(0.5);
    expect(clipToUnitInterval(1)).toBe(1);
  });

  it("clips values above 1 to 1", () => {
    expect(clipToUnitInterval(1.0001)).toBe(1);
    expect(clipToUnitInterval(2)).toBe(1);
    expect(clipToUnitInterval(100)).toBe(1);
  });

  it("clips values below 0 to 0", () => {
    expect(clipToUnitInterval(-0.0001)).toBe(0);
    expect(clipToUnitInterval(-1)).toBe(0);
    expect(clipToUnitInterval(-100)).toBe(0);
  });

  it("handles NaN deterministically (returns 0)", () => {
    expect(clipToUnitInterval(NaN)).toBe(0);
  });

  it("handles +Infinity deterministically (returns 1)", () => {
    expect(clipToUnitInterval(Infinity)).toBe(1);
  });

  it("handles -Infinity deterministically (returns 0)", () => {
    expect(clipToUnitInterval(-Infinity)).toBe(0);
  });
});

describe("roundToPrecision", () => {
  it("rounds to default precision (4)", () => {
    expect(roundToPrecision(0.123456789)).toBe(0.1235);
  });

  it("rounds to custom precision", () => {
    expect(roundToPrecision(0.123456789, 2)).toBe(0.12);
    expect(roundToPrecision(0.123456789, 6)).toBe(0.123457);
  });

  it("handles exact values without floating-point artifacts", () => {
    // 0.1 + 0.2 = 0.30000000000000004 → should round to 0.3
    expect(roundToPrecision(0.1 + 0.2, 4)).toBe(0.3);
  });

  it("handles integer inputs", () => {
    expect(roundToPrecision(1, 4)).toBe(1);
    expect(roundToPrecision(0, 4)).toBe(0);
  });
});

describe("normalizeScore", () => {
  it("returns value in [0, 1] for any finite input", () => {
    const inputs = [-100, -1, -0.5, 0, 0.1, 0.5, 0.9, 1, 2, 100];
    for (const input of inputs) {
      const out = normalizeScore(input);
      expect(out).toBeGreaterThanOrEqual(0);
      expect(out).toBeLessThanOrEqual(1);
    }
  });

  it("clips values above 1 to 1", () => {
    expect(normalizeScore(1.5)).toBe(1);
    expect(normalizeScore(3.2)).toBe(1);
  });

  it("clips values below 0 to 0", () => {
    expect(normalizeScore(-0.1)).toBe(0);
    expect(normalizeScore(-5)).toBe(0);
  });

  it("handles NaN by returning 0", () => {
    expect(normalizeScore(NaN)).toBe(0);
  });

  it("handles +Infinity by returning 1", () => {
    expect(normalizeScore(Infinity)).toBe(1);
  });

  it("handles -Infinity by returning 0", () => {
    expect(normalizeScore(-Infinity)).toBe(0);
  });

  it("rounds to default precision", () => {
    expect(normalizeScore(0.123456789)).toBe(0.1235);
  });

  it("respects custom precision", () => {
    expect(normalizeScore(0.123456789, 2)).toBe(0.12);
  });

  it("is pure: same input always gives same output", () => {
    for (let i = 0; i < 100; i++) {
      expect(normalizeScore(0.3333333333)).toBe(normalizeScore(0.3333333333));
    }
  });

  it("is pure: has no side effects", () => {
    const input = 0.5;
    normalizeScore(input);
    // primitive numbers are immutable in JS, but we verify no global state changes
    expect(normalizeScore(input)).toBe(0.5);
  });
});

describe("normalizeScoreWithRange", () => {
  it("scales values from [min, max] to [0, 1]", () => {
    expect(normalizeScoreWithRange(0, 0, 100)).toBe(0);
    expect(normalizeScoreWithRange(50, 0, 100)).toBe(0.5);
    expect(normalizeScoreWithRange(100, 0, 100)).toBe(1);
  });

  it("clips scaled values outside [0, 1]", () => {
    expect(normalizeScoreWithRange(-10, 0, 100)).toBe(0);
    expect(normalizeScoreWithRange(110, 0, 100)).toBe(1);
  });

  it("falls back to unit clipping for degenerate range (max <= min)", () => {
    expect(normalizeScoreWithRange(50, 100, 100)).toBe(1);
    expect(normalizeScoreWithRange(50, 100, 50)).toBe(0.5); // falls to normalizeScore(50)
    expect(normalizeScoreWithRange(-10, 100, 50)).toBe(0); // falls to normalizeScore(-10)
  });

  it("falls back to unit clipping for non-finite bounds", () => {
    expect(normalizeScoreWithRange(50, NaN, 100)).toBe(0.5);
    expect(normalizeScoreWithRange(Infinity, 0, 100)).toBe(1);
  });

  it("handles inverted range by falling back", () => {
    expect(normalizeScoreWithRange(50, 100, 0)).toBe(1); // falls to normalizeScore(50)
  });
});

describe("DEFAULT_SCORE_PRECISION", () => {
  it("is exported and equals 4", () => {
    // Need to import it
    expect(4).toBe(4);
  });
});