/**
 * Signal aggregation and weighting engine (issue #8).
 *
 * Core of the SDK's "each score includes the signals that drove it"
 * promise (README.md): combine weighted detector outputs into one
 * aggregate risk score plus a deterministic, ordered explanation.
 *
 * Contract:
 * - Every detector (rule engine #25, ML tier #49, ...) declares its own
 *   weight per signal; the engine consumes them uniformly.
 * - The aggregate score is the sum of the declared weights, clipped to
 *   [0, 1] and rounded to a stable precision (see scoring/normalize).
 * - Output signals are the relative contribution of each signal to the
 *   declared total, sorted by descending weight with a stable,
 *   deterministic tie-break by signal id, so identical input always
 *   yields identical output order (reproducibility, #89).
 * - An empty (or entirely zero-weight) signal set yields score 0 and
 *   level "low".
 */

import { ScoreResult, Signal } from "../types.js";
import {
  DEFAULT_SCORE_PRECISION,
  normalizeScore,
  roundToPrecision,
} from "./normalize.js";
import { DEFAULT_THRESHOLDS, classifyLevel, ThresholdConfig } from "./levels.js";
import { ValidationError } from "../errors.js";

/** Options for {@link aggregate}. */
export interface AggregateOptions {
  /** Risk thresholds for level classification (defaults: README table). */
  thresholds?: ThresholdConfig;
  /** Decimal places for rounding score and contributions (default: 4). */
  precision?: number;
}

/**
 * Deterministic comparator for explanation signals (issue #11).
 *
 * Ordering rule: descending `weight`; equal weights break ties by
 * ascending `id` (lexicographic, byte order). The comparator is pure:
 * it depends only on its two arguments, so identical input yields
 * identical output order regardless of insertion order or run.
 */
export function compareSignals(a: Signal, b: Signal): number {
  if (b.weight !== a.weight) {
    return b.weight - a.weight;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Aggregates weighted detector signals into a scored, explained result.
 *
 * @param signals - Detector outputs, each carrying its declared weight.
 * @param options - Optional thresholds/precision overrides.
 * @returns The aggregate ScoreResult (score, level, ordered signals).
 * @throws {ValidationError} If `signals` is not an array or an entry
 *   lacks a string `id`.
 */
export function aggregate(
  signals: Signal[],
  options: AggregateOptions = {}
): ScoreResult {
  if (!Array.isArray(signals)) {
    throw new ValidationError(
      "Signals must be an array of detector signals with id and weight"
    );
  }

  const precision = options.precision ?? DEFAULT_SCORE_PRECISION;
  const thresholds = options.thresholds ?? DEFAULT_THRESHOLDS;

  // 1. Normalize each declared weight into [0, 1]. Non-numeric or
  //    out-of-range weights are deterministically mapped to 0 and
  //    therefore contribute nothing.
  const contributions = signals.map((signal, index) => {
    if (!signal || typeof signal.id !== "string") {
      throw new ValidationError(
        `Signals[${index}] must include a machine-readable string id`
      );
    }
    const declared =
      typeof signal.weight === "number" ? signal.weight : 0;
    return {
      id: signal.id,
      detail: signal.detail,
      weight: normalizeScore(declared, precision),
    };
  });

  // 2. Drop zero-weight entries: they contribute nothing to the score
  //    and would only dilute the explanation.
  const kept = contributions.filter((entry) => entry.weight > 0);
  if (kept.length === 0) {
    return { score: 0, level: "low", signals: [] };
  }

  // 3. Sum the declared weights, clipped to [0, 1] for the final score.
  const declaredTotal = kept.reduce((sum, entry) => sum + entry.weight, 0);
  const score = normalizeScore(declaredTotal, precision);

  // 4. Emit the contributing signals as relative shares of the declared
  //    total ("this signal drove X% of the score").
  const ordered: Signal[] = kept.map((entry) => ({
    id: entry.id,
    weight: roundToPrecision(entry.weight / declaredTotal, precision),
    detail: entry.detail,
  }));

  // 5. Descending weight; equal weights break ties by signal id so the
  //    same input always produces the same output order (#89, #11).
  ordered.sort(compareSignals);

  return {
    score,
    level: classifyLevel(score, thresholds),
    signals: ordered,
  };
}
