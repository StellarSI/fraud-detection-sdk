/**
 * Score normalization utilities.
 *
 * Clips and rounds raw detector output to the documented 0–1 risk score range.
 * Pure, side-effect-free, and deterministic for all finite and non-finite inputs.
 */

/**
 * Default number of decimal places to round normalized scores to.
 * Matches the precision implied by the README risk-level thresholds.
 */
export const DEFAULT_SCORE_PRECISION = 4;

/**
 * Clips a raw numeric value to the closed interval [0, 1].
 *
 * - Values > 1 become 1
 * - Values < 0 become 0
 * - NaN becomes 0 (deterministic rejection of invalid input)
 * - Infinity becomes 1; -Infinity becomes 0
 *
 * @param raw - Raw detector output, any finite or non-finite number.
 * @returns Value in [0, 1].
 */
export function clipToUnitInterval(raw: number): number {
  if (!Number.isFinite(raw)) {
    // NaN, +Infinity, -Infinity → deterministic fallback
    return raw > 0 ? 1 : 0;
  }
  if (raw > 1) return 1;
  if (raw < 0) return 0;
  return raw;
}

/**
 * Rounds a number to a fixed precision.
 *
 * Uses `toFixed` internally to avoid floating-point representation artifacts
 * (e.g., 0.1 + 0.2 = 0.30000000000000004).
 *
 * @param value - Number to round.
 * @param precision - Decimal places (default: 4).
 * @returns Rounded number.
 */
export function roundToPrecision(value: number, precision: number = DEFAULT_SCORE_PRECISION): number {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}

/**
 * Normalizes a raw detector output to the 0–1 risk score range.
 *
 * Pipeline:
 * 1. Clip to [0, 1] (handles NaN/Infinity deterministically)
 * 2. Round to stable precision
 *
 * No sigmoid, min-max scaling, or other transformations are applied.
 * The function preserves raw ratios and only bounds them.
 *
 * @param raw - Raw detector output.
 * @param precision - Optional decimal places for rounding (default: 4).
 * @returns Normalized score in [0, 1].
 */
export function normalizeScore(raw: number, precision: number = DEFAULT_SCORE_PRECISION): number {
  const clipped = clipToUnitInterval(raw);
  return roundToPrecision(clipped, precision);
}

/**
 * Normalizes a raw detector output given a known detector-specific range.
 *
 * Useful when a detector has a well-defined output range (e.g., [0, 100])
 * and you want to scale it linearly to [0, 1] before clipping.
 *
 * @param raw - Raw detector output.
 * @param min - Minimum expected value for this detector.
 * @param max - Maximum expected value for this detector.
 * @param precision - Optional decimal places for rounding (default: 4).
 * @returns Normalized score in [0, 1].
 */
export function normalizeScoreWithRange(
  raw: number,
  min: number,
  max: number,
  precision: number = DEFAULT_SCORE_PRECISION
): number {
  if (!Number.isFinite(raw) || !Number.isFinite(min) || !Number.isFinite(max)) {
    return normalizeScore(raw, precision);
  }
  if (max <= min) {
    // Degenerate or inverted range → fall back to unit clipping
    return normalizeScore(raw, precision);
  }
  const scaled = (raw - min) / (max - min);
  return normalizeScore(scaled, precision);
}