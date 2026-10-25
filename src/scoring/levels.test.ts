/**
 * Tests for risk level classification utilities.
 *
 * Covers classification logic, threshold validation, and edge cases.
 */

import { describe, it, expect } from "vitest";
import {
  classifyLevel,
  classify,
  getSuggestedAction,
  validateThresholds,
  DEFAULT_THRESHOLDS,
  ThresholdConfig,
} from "./levels.js";

describe("DEFAULT_THRESHOLDS", () => {
  it("matches the README risk-level table defaults", () => {
    expect(DEFAULT_THRESHOLDS.low).toBe(0.40);
    expect(DEFAULT_THRESHOLDS.high).toBe(0.70);
  });
});

describe("validateThresholds", () => {
  it("accepts valid default thresholds", () => {
    expect(() => validateThresholds(DEFAULT_THRESHOLDS)).not.toThrow();
  });

  it("accepts valid custom thresholds", () => {
    expect(() => validateThresholds({ low: 0.3, high: 0.8 })).not.toThrow();
    expect(() => validateThresholds({ low: 0.1, high: 0.9 })).not.toThrow();
    expect(() => validateThresholds({ low: 0.0, high: 1.0 })).not.toThrow();
  });

  it("rejects low < 0", () => {
    expect(() => validateThresholds({ low: -0.1, high: 0.8 })).toThrow(
      "Low threshold must be in [0, 1]"
    );
  });

  it("rejects low > 1", () => {
    expect(() => validateThresholds({ low: 1.1, high: 0.8 })).toThrow(
      "Low threshold must be in [0, 1]"
    );
  });

  it("rejects high < 0", () => {
    expect(() => validateThresholds({ low: 0.3, high: -0.1 })).toThrow(
      "High threshold must be in [0, 1]"
    );
  });

  it("rejects high > 1", () => {
    expect(() => validateThresholds({ low: 0.3, high: 1.1 })).toThrow(
      "High threshold must be in [0, 1]"
    );
  });

  it("rejects low >= high", () => {
    expect(() => validateThresholds({ low: 0.7, high: 0.7 })).toThrow(
      "Low threshold (0.7) must be strictly less than high threshold (0.7)"
    );
    expect(() => validateThresholds({ low: 0.8, high: 0.7 })).toThrow(
      "Low threshold (0.8) must be strictly less than high threshold (0.7)"
    );
  });

  it("rejects non-finite low", () => {
    expect(() => validateThresholds({ low: NaN, high: 0.8 })).toThrow(
      "Thresholds must be finite numbers"
    );
    expect(() => validateThresholds({ low: Infinity, high: 0.8 })).toThrow(
      "Thresholds must be finite numbers"
    );
  });

  it("rejects non-finite high", () => {
    expect(() => validateThresholds({ low: 0.3, high: NaN })).toThrow(
      "Thresholds must be finite numbers"
    );
    expect(() => validateThresholds({ low: 0.3, high: Infinity })).toThrow(
      "Thresholds must be finite numbers"
    );
  });

  it("rejects non-number thresholds", () => {
    expect(() => validateThresholds({ low: "0.3" as any, high: 0.8 })).toThrow(
      "Thresholds must be numbers"
    );
    expect(() => validateThresholds({ low: 0.3, high: "0.7" as any })).toThrow(
      "Thresholds must be numbers"
    );
  });
});

describe("classifyLevel", () => {
  it("classifies scores below 0.40 as low (default)", () => {
    expect(classifyLevel(0.0)).toBe("low");
    expect(classifyLevel(0.2)).toBe("low");
    expect(classifyLevel(0.39)).toBe("low");
    expect(classifyLevel(0.3999)).toBe("low");
  });

  it("classifies scores in [0.40, 0.70] as medium (default)", () => {
    expect(classifyLevel(0.40)).toBe("medium");
    expect(classifyLevel(0.5)).toBe("medium");
    expect(classifyLevel(0.6)).toBe("medium");
    expect(classifyLevel(0.70)).toBe("medium");
  });

  it("classifies scores above 0.70 as high (default)", () => {
    expect(classifyLevel(0.7001)).toBe("high");
    expect(classifyLevel(0.8)).toBe("high");
    expect(classifyLevel(0.9)).toBe("high");
    expect(classifyLevel(1.0)).toBe("high");
  });

  it("uses custom thresholds correctly", () => {
    const custom: { low: number; high: number } = { low: 0.3, high: 0.8 };
    expect(classifyLevel(0.2, custom)).toBe("low");
    expect(classifyLevel(0.5, custom)).toBe("medium");
    expect(classifyLevel(0.9, custom)).toBe("high");
  });

  it("throws for score < 0", () => {
    expect(() => classifyLevel(-0.1)).toThrow("Score must be in [0, 1]");
    expect(() => classifyLevel(-1)).toThrow("Score must be in [0, 1]");
  });

  it("throws for score > 1", () => {
    expect(() => classifyLevel(1.0001)).toThrow("Score must be in [0, 1]");
    expect(() => classifyLevel(2)).toThrow("Score must be in [0, 1]");
  });

  it("throws for NaN score", () => {
    expect(() => classifyLevel(NaN)).toThrow("Score must be a finite number");
  });

  it("throws for Infinity score", () => {
    expect(() => classifyLevel(Infinity)).toThrow("Score must be a finite number");
    expect(() => classifyLevel(-Infinity)).toThrow("Score must be a finite number");
  });

  it("throws for non-finite score", () => {
    expect(() => classifyLevel(NaN)).toThrow("Score must be a finite number");
  });

  it("throws for invalid custom thresholds (low >= high)", () => {
    expect(() => classifyLevel(0.5, { low: 0.7, high: 0.7 })).toThrow(
      "Low threshold (0.7) must be strictly less than high threshold (0.7)"
    );
  });

  it("throws for custom thresholds with low < 0", () => {
    expect(() => classifyLevel(0.5, { low: -0.1, high: 0.8 })).toThrow(
      "Low threshold must be in [0, 1]"
    );
  });

  it("throws for invalid custom thresholds (high > 1)", () => {
    expect(() => classifyLevel(0.5, { low: 0.3, high: 1.1 })).toThrow(
      "High threshold must be in [0, 1]"
    );
  });

  it("classifies boundary values deterministically", () => {
    // With default thresholds (0.4, 0.7)
    // low: < 0.4
    // medium: >= 0.4 and <= 0.7
    // high: > 0.7

    expect(classifyLevel(0.399999)).toBe("low");
    expect(classifyLevel(0.4)).toBe("medium");
    expect(classifyLevel(0.7)).toBe("medium");
    expect(classifyLevel(0.700001)).toBe("high");
  });
});

describe("classify", () => {
  it("returns ClassificationResult with level and suggestedAction", () => {
    const result = classify(0.3);
    expect(result).toEqual({
      level: "low",
      suggestedAction: "Proceed normally",
    });
  });

  it("returns medium with correct action", () => {
    const result = classify(0.5);
    expect(result).toEqual({
      level: "medium",
      suggestedAction: "Log and monitor",
    });
  });

  it("returns high with correct action", () => {
    const result = classify(0.9);
    expect(result).toEqual({
      level: "high",
      suggestedAction: "Hold and require manual review",
    });
  });
});

describe("getSuggestedAction", () => {
  it("returns correct action for low", () => {
    expect(getSuggestedAction("low")).toBe("Proceed normally");
  });

  it("returns correct action for medium", () => {
    expect(getSuggestedAction("medium")).toBe("Log and monitor");
  });

  it("returns correct action for high", () => {
    expect(getSuggestedAction("high")).toBe("Hold and require manual review");
  });
});