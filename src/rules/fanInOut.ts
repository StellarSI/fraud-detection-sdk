/**
 * Rapid fan-in / fan-out detector rule (issue #37).
 *
 * Rapid fan-in / fan-out across many accounts within a few ledgers is a
 * headline Stellar abuse pattern (README.md:25) and the classic layering
 * signature. This rule consumes the fan-in / fan-out features (#37) and
 * emits distinct `fan-in` and `fan-out` signals whose weights scale with
 * the number of counterparties and the speed at which they appeared.
 *
 * A fan is flagged only when a small-window burst or a high per-ledger rate
 * is present (a very large window-wide degree also qualifies), so steady,
 * high-volume actors such as anchors and market makers are not flagged by
 * accident. Directions are evaluated independently and may be disabled
 * separately to tune the alert surface per environment.
 */

import type { Signal } from "../types.js";
import type { Rule, RuleContext } from "./engine.js";
import { ValidationError } from "../errors.js";

/** Default rule weight (engine contribution) in [0, 1]. */
export const DEFAULT_FAN_IN_OUT_RULE_WEIGHT = 0.6;

/** Default minimum severity required to emit a signal. */
export const DEFAULT_FAN_IN_OUT_MIN_SCORE = 0.05;

/** Default distinct counterparties in the window that constitutes a fan. */
export const DEFAULT_FAN_IN_OUT_DEGREE_THRESHOLD = 10;

/** Default distinct counterparties in the burst window that constitutes a burst. */
export const DEFAULT_FAN_IN_OUT_BURST_THRESHOLD = 5;

/** Default peak distinct counterparties per ledger that reads as a burst. */
export const DEFAULT_FAN_IN_OUT_SPEED_THRESHOLD = 3;

/** Fallback burst-window size (in ledgers) used in human-readable details. */
const FALLBACK_BURST_LEDGERS = 3;

export interface FanInOutRuleOptions {
  /**
   * Base rule weight (engine contribution) in [0, 1].
   * The emitted signal weight scales by severity; the engine combines them.
   */
  readonly weight?: number;
  /** Minimum severity score required to emit a signal. Default: 0.05. */
  readonly minScore?: number;
  /** Window-wide degree treated as a fan. Must be >= 1. Default: 10. */
  readonly degreeThreshold?: number;
  /** Burst-window degree treated as a burst. Must be >= 1. Default: 5. */
  readonly burstThreshold?: number;
  /** Peak counterparties per ledger treated as a burst. Must be >= 1. Default: 3. */
  readonly speedThreshold?: number;
  /** Evaluate fan-in (many senders paying the account). Default: true. */
  readonly enableFanIn?: boolean;
  /** Evaluate fan-out (many recipients paid by the account). Default: true. */
  readonly enableFanOut?: boolean;
}

function resolveNumber(
  value: number | undefined,
  fallback: number,
  label: string
): number {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ValidationError(`${label} must be a finite number`);
  }
  return value;
}

function resolvePositiveInteger(
  value: number | undefined,
  fallback: number,
  label: string
): number {
  const resolved = resolveNumber(value, fallback, label);
  if (!Number.isInteger(resolved) || resolved < 1) {
    throw new ValidationError(`${label} must be a positive integer`);
  }
  return resolved;
}

function resolveBoolean(
  value: boolean | undefined,
  fallback: boolean,
  label: string
): boolean {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "boolean") {
    throw new ValidationError(`${label} must be a boolean`);
  }
  return value;
}

function num(context: RuleContext, key: string): number {
  const value = context[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }
  if (value >= 1) {
    return 1;
  }
  return Math.round(value * 10_000) / 10_000;
}

interface DirectionResult {
  readonly severity: number;
  readonly degree: number;
  readonly burst: number;
  readonly peak: number;
}

function evaluateDirection(
  degree: number,
  burst: number,
  peak: number,
  degreeThreshold: number,
  burstThreshold: number,
  speedThreshold: number
): DirectionResult | null {
  const degreeTriggered = degree >= degreeThreshold;
  const burstTriggered = burst >= burstThreshold;
  const speedTriggered = peak >= speedThreshold;
  if (!degreeTriggered && !burstTriggered && !speedTriggered) {
    return null;
  }

  const severity = clamp01(
    Math.max(
      degree / (degreeThreshold * 2),
      burst / (burstThreshold * 2),
      peak / (speedThreshold * 2)
    )
  );
  return { severity, degree, burst, peak };
}

/**
 * Creates the rapid fan-in / fan-out rule.
 *
 * Reads features produced by `extractFanInOutFeatures` /
 * `createFanInOutFeatureProvider` (#37): `fanInDegree`, `fanOutDegree`,
 * `fanInBurstCount`, `fanOutBurstCount`, `fanPeakInPerLedger`,
 * `fanPeakOutPerLedger`, and `fanBurstLedgers`.
 *
 * Returns one signal per triggered direction so reviewers can tell a fan-in
 * (many senders) from a fan-out (many recipients).
 */
export function createFanInOutRule(
  options: FanInOutRuleOptions = {}
): Rule {
  const weight = resolveNumber(
    options.weight,
    DEFAULT_FAN_IN_OUT_RULE_WEIGHT,
    "weight"
  );
  const minScore = resolveNumber(
    options.minScore,
    DEFAULT_FAN_IN_OUT_MIN_SCORE,
    "minScore"
  );
  if (minScore < 0 || minScore > 1) {
    throw new ValidationError("minScore must be in [0, 1]");
  }
  const degreeThreshold = resolvePositiveInteger(
    options.degreeThreshold,
    DEFAULT_FAN_IN_OUT_DEGREE_THRESHOLD,
    "degreeThreshold"
  );
  const burstThreshold = resolvePositiveInteger(
    options.burstThreshold,
    DEFAULT_FAN_IN_OUT_BURST_THRESHOLD,
    "burstThreshold"
  );
  const speedThreshold = resolvePositiveInteger(
    options.speedThreshold,
    DEFAULT_FAN_IN_OUT_SPEED_THRESHOLD,
    "speedThreshold"
  );
  const enableFanIn = resolveBoolean(options.enableFanIn, true, "enableFanIn");
  const enableFanOut = resolveBoolean(options.enableFanOut, true, "enableFanOut");
  if (!enableFanIn && !enableFanOut) {
    throw new ValidationError("at least one direction must be enabled");
  }

  return {
    id: "fan-in-out",
    weight,
    evaluate(context: RuleContext): Signal[] | null {
      const burstLedgers = num(context, "fanBurstLedgers") || FALLBACK_BURST_LEDGERS;

      const fanIn = enableFanIn
        ? evaluateDirection(
            num(context, "fanInDegree"),
            num(context, "fanInBurstCount"),
            num(context, "fanPeakInPerLedger"),
            degreeThreshold,
            burstThreshold,
            speedThreshold
          )
        : null;
      const fanOut = enableFanOut
        ? evaluateDirection(
            num(context, "fanOutDegree"),
            num(context, "fanOutBurstCount"),
            num(context, "fanPeakOutPerLedger"),
            degreeThreshold,
            burstThreshold,
            speedThreshold
          )
        : null;

      if (fanIn === null && fanOut === null) {
        return null;
      }

      const signals: Signal[] = [];
      if (fanIn !== null && fanIn.severity >= minScore) {
        signals.push({
          id: "fan-in",
          weight: fanIn.severity,
          detail:
            `Rapid fan-in: ${fanIn.degree} distinct senders in the window, ` +
            `${fanIn.burst} within the last ${burstLedgers} ledgers, ` +
            `peak ${fanIn.peak} per ledger`,
        });
      }
      if (fanOut !== null && fanOut.severity >= minScore) {
        signals.push({
          id: "fan-out",
          weight: fanOut.severity,
          detail:
            `Rapid fan-out: ${fanOut.degree} distinct recipients in the window, ` +
            `${fanOut.burst} within the last ${burstLedgers} ledgers, ` +
            `peak ${fanOut.peak} per ledger`,
        });
      }

      return signals.length > 0 ? signals : null;
    },
  };
}

export default createFanInOutRule;
