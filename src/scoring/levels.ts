/**
 * Risk level classification utilities.
 *
 * Implements the three-band risk classification from the README:
 * - low: score < lowThreshold
 * - medium: lowThreshold <= score <= highThreshold
 * - high: score > highThreshold
 *
 * Thresholds are configurable per-detector-instance (see FraudDetectorOptions).
 */

import { RiskLevel } from "../types.js";

/**
 * Default risk thresholds matching the README risk-level table.
 * @see README.md:74-78
 */
export const DEFAULT_THRESHOLDS = {
  low: 0.40,
  high: 0.70,
} as const;

/**
 * Configuration for risk thresholds.
 * Allows customization of the low/medium/high boundaries.
 */
export interface ThresholdConfig {
  /** Score below this is classified as "low". Default: 0.40 */
  low: number;
  /** Score above this is classified as "high". Default: 0.70 */
  high: number;
}

/**
 * Validates threshold configuration.
 *
 * @param thresholds - Threshold configuration to validate.
 * @throws {Error} If thresholds are invalid (not in [0,1], low >= high, etc.)
 */
export function validateThresholds(thresholds: ThresholdConfig): void {
  const { low, high } = thresholds;

  if (!Number.isFinite(low) || !Number.isFinite(high)) {
    throw new Error("Thresholds must be finite numbers");
  }

  if (low < 0 || low > 1) {
    throw new Error(`Low threshold must be in [0, 1], got ${low}`);
  }

  if (high < 0 || high > 1) {
    throw new Error(`High threshold must be in [0, 1], got ${high}`);
  }

  if (low >= high) {
    throw new Error(
      `Low threshold (${low}) must be strictly less than high threshold (${high})`
    );
  }
}

/**
 * Classifies a risk score into a risk level using the provided thresholds.
 *
 * Boundary behavior:
 * - score < low → "low"
 * - low <= score <= high → "medium"
 * - score > high → "high"
 *
 * @param score - Normalized risk score in [0, 1]
 * @param thresholds - Optional threshold configuration. Defaults to DEFAULT_THRESHOLDS.
 * @returns RiskLevel classification
 * @throws {Error} If score is not a finite number in [0, 1]
 * @throws {Error} If thresholds are invalid
 *
 * @example
 * classifyLevel(0.35) // "low"
 * classifyLevel(0.50) // "medium"
 * classifyLevel(0.85) // "high"
 * classifyLevel(0.40, { low: 0.3, high: 0.8 }) // "medium" (custom thresholds)
 */
export function classifyLevel(
  score: number,
  thresholds: ThresholdConfig = DEFAULT_THRESHOLDS
): RiskLevel {
  if (!Number.isFinite(score)) {
    throw new Error(`Score must be a finite number, got ${score}`);
  }

  if (score < 0 || score > 1) {
    throw new Error(`Score must be in [0, 1], got ${score}`);
  }

  validateThresholds(thresholds);

  if (score < thresholds.low) {
    return "low";
  }

  if (score > thresholds.high) {
    return "high";
  }

  return "medium";
}

/**
 * Returns the suggested action for a given risk level.
 * Matches the "Suggested action" column in the README risk-level table.
 */
export function getSuggestedAction(level: RiskLevel): string {
  switch (level) {
    case "low":
      return "Proceed normally";
    case "medium":
      return "Log and monitor";
    case "high":
      return "Hold and require manual review";
    default:
      // Exhaustiveness check
      const exhaustive: never = level;
      throw new Error(`Unknown risk level: ${exhaustive}`);
  }
}

/**
 * Returns the full classification result with level and suggested action.
 */
export interface ClassificationResult {
  level: RiskLevel;
  suggestedAction: string;
}

export function classify(score: number, thresholds?: ThresholdConfig): ClassificationResult {
  const level = classifyLevel(score, thresholds);
  return {
    level,
    suggestedAction: getSuggestedAction(level),
  };
}