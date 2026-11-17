/**
 * Clawback-enabled asset activity detector rule (issue #36).
 *
 * Clawback is a powerful issuer capability; unusual activity around
 * clawback-enabled assets is a compliance-relevant signal explicitly named
 * in the spec (README.md:24, README.md:22). This rule consumes the
 * clawback-activity features (#36, built on asset features #21) and emits a
 * `clawback-activity` signal whose weight scales with the operation count,
 * volume, and frequency observed.
 *
 * Every alert class — clawback operations, unusual volume, and unusual
 * frequency — is individually toggle-able and thresholded so operators can
 * tune the alert surface per environment. Ordinary activity on
 * clawback-enabled assets (no operations, normal volume and frequency)
 * emits nothing.
 */

import type { Signal } from "../types.js";
import type { Rule, RuleContext } from "./engine.js";
import { ValidationError } from "../errors.js";

/** Default rule weight (engine contribution) in [0, 1]. */
export const DEFAULT_CLAWBACK_ACTIVITY_RULE_WEIGHT = 0.6;

/** Default minimum severity required to emit a signal. */
export const DEFAULT_CLAWBACK_ACTIVITY_MIN_SCORE = 0.05;

/** Default number of clawback operations that is itself actionable. */
export const DEFAULT_CLAWBACK_ACTIVITY_OPERATION_THRESHOLD = 1;

/** Default amount (or single-transfer amount) treated as unusual volume. */
export const DEFAULT_CLAWBACK_ACTIVITY_VOLUME_THRESHOLD = 1000;

/** Default transaction count treated as unusual frequency. */
export const DEFAULT_CLAWBACK_ACTIVITY_FREQUENCY_THRESHOLD = 3;

/** Default burst count treated as unusual frequency by the rule. */
export const DEFAULT_CLAWBACK_ACTIVITY_RULE_BURST_THRESHOLD = 3;

export interface ClawbackActivityRuleOptions {
  /**
   * Base rule weight (engine contribution) in [0, 1].
   * The emitted signal weight scales by severity; the engine combines them.
   */
  readonly weight?: number;
  /** Minimum severity score required to emit a signal. Default: 0.05. */
  readonly minScore?: number;
  /** Clawback operations that count as an alert. Must be >= 1. Default: 1. */
  readonly operationThreshold?: number;
  /** Amount treated as unusual volume. Must be > 0. Default: 1000. */
  readonly volumeThreshold?: number;
  /** Transaction count treated as unusual frequency. Must be >= 1. Default: 3. */
  readonly frequencyThreshold?: number;
  /** Burst count treated as unusual frequency. Must be >= 1. Default: 3. */
  readonly burstThreshold?: number;
  /** Flag clawback operations. Default: true. */
  readonly enableOperationAlerts?: boolean;
  /** Flag unusual volume around clawback-enabled assets. Default: true. */
  readonly enableVolumeAnomalies?: boolean;
  /** Flag unusual transaction frequency/bursts. Default: true. */
  readonly enableFrequencyAnomalies?: boolean;
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

function resolvePositive(
  value: number | undefined,
  fallback: number,
  label: string
): number {
  const resolved = resolveNumber(value, fallback, label);
  if (resolved <= 0) {
    throw new ValidationError(`${label} must be a positive finite number`);
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

/**
 * Creates the clawback-enabled asset activity rule.
 *
 * Reads features produced by `extractClawbackActivityFeatures` /
 * `createClawbackActivityFeatureProvider` (#36):
 * `clawbackEnabledAssetCount`, `clawbackTransactionCount`,
 * `clawbackOperationCount`, `clawbackBurstCount`, `clawbackBurstDetected`,
 * `clawbackDistinctAssetCount`, `clawbackTotalVolume`, and
 * `clawbackMaxAmount`.
 */
export function createClawbackActivityRule(
  options: ClawbackActivityRuleOptions = {}
): Rule {
  const weight = resolveNumber(
    options.weight,
    DEFAULT_CLAWBACK_ACTIVITY_RULE_WEIGHT,
    "weight"
  );
  const minScore = resolveNumber(
    options.minScore,
    DEFAULT_CLAWBACK_ACTIVITY_MIN_SCORE,
    "minScore"
  );
  if (minScore < 0 || minScore > 1) {
    throw new ValidationError("minScore must be in [0, 1]");
  }
  const operationThreshold = resolvePositiveInteger(
    options.operationThreshold,
    DEFAULT_CLAWBACK_ACTIVITY_OPERATION_THRESHOLD,
    "operationThreshold"
  );
  const volumeThreshold = resolvePositive(
    options.volumeThreshold,
    DEFAULT_CLAWBACK_ACTIVITY_VOLUME_THRESHOLD,
    "volumeThreshold"
  );
  const frequencyThreshold = resolvePositiveInteger(
    options.frequencyThreshold,
    DEFAULT_CLAWBACK_ACTIVITY_FREQUENCY_THRESHOLD,
    "frequencyThreshold"
  );
  const burstThreshold = resolvePositiveInteger(
    options.burstThreshold,
    DEFAULT_CLAWBACK_ACTIVITY_RULE_BURST_THRESHOLD,
    "burstThreshold"
  );
  const enableOperationAlerts = resolveBoolean(
    options.enableOperationAlerts,
    true,
    "enableOperationAlerts"
  );
  const enableVolumeAnomalies = resolveBoolean(
    options.enableVolumeAnomalies,
    true,
    "enableVolumeAnomalies"
  );
  const enableFrequencyAnomalies = resolveBoolean(
    options.enableFrequencyAnomalies,
    true,
    "enableFrequencyAnomalies"
  );
  if (
    !enableOperationAlerts &&
    !enableVolumeAnomalies &&
    !enableFrequencyAnomalies
  ) {
    throw new ValidationError(
      "at least one alert class must be enabled " +
        "(enableOperationAlerts, enableVolumeAnomalies, enableFrequencyAnomalies)"
    );
  }

  return {
    id: "clawback-activity",
    weight,
    evaluate(context: RuleContext): Signal | null {
      const enabledAssetCount = num(context, "clawbackEnabledAssetCount");
      const operationCount = num(context, "clawbackOperationCount");
      const transactionCount = num(context, "clawbackTransactionCount");
      const burstCount = num(context, "clawbackBurstCount");
      const burstDetected = context["clawbackBurstDetected"] === true;
      const volume = num(context, "clawbackTotalVolume");
      const maxAmount = num(context, "clawbackMaxAmount");
      const distinctAssets = num(context, "clawbackDistinctAssetCount");

      if (
        enabledAssetCount <= 0 &&
        operationCount <= 0 &&
        transactionCount <= 0
      ) {
        return null;
      }

      const reasons: string[] = [];
      let severity = 0;

      // Clawback operations are actionable on their own: the issuer is
      // actively confiscating (or reclaiming) value.
      if (enableOperationAlerts && operationCount >= operationThreshold) {
        const operationSeverity = clamp01(
          0.5 + 0.25 * Math.min(operationCount - operationThreshold, 2)
        );
        severity = Math.max(severity, operationSeverity);
        reasons.push(
          `${operationCount} clawback operation${operationCount === 1 ? "" : "s"}`
        );
      }

      // Unusual volume around clawback-enabled assets: a large aggregate or
      // one unusually large transfer.
      const consideredVolume = Math.max(volume, maxAmount);
      if (
        enableVolumeAnomalies &&
        consideredVolume >= volumeThreshold &&
        consideredVolume > 0
      ) {
        const volumeSeverity = clamp01(consideredVolume / (volumeThreshold * 2));
        severity = Math.max(severity, volumeSeverity);
        reasons.push(
          `volume ${volume} (largest transfer ${maxAmount}) around ` +
            `clawback-enabled assets`
        );
      }

      // Unusual frequency: many transactions or a burst inside a short window.
      if (
        enableFrequencyAnomalies &&
        (transactionCount >= frequencyThreshold ||
          burstCount >= burstThreshold ||
          burstDetected)
      ) {
        const frequencySeverity = clamp01(
          Math.max(
            transactionCount / (frequencyThreshold * 2),
            burstCount / (burstThreshold * 2)
          )
        );
        severity = Math.max(severity, frequencySeverity);
        reasons.push(
          `${transactionCount} transaction(s) with ${burstCount} in the burst window`
        );
      }

      if (reasons.length === 0) {
        // Only benign, unchanged activity on clawback-enabled assets.
        return null;
      }

      if (severity < minScore) {
        return null;
      }

      if (enabledAssetCount > 0 || distinctAssets > 0) {
        reasons.push(
          `${distinctAssets} clawback-enabled asset(s) seen of ` +
            `${enabledAssetCount} held`
        );
      }

      return {
        id: "clawback-activity",
        weight: Math.round(Math.min(Math.max(severity, 0), 1) * 10_000) / 10_000,
        detail: `Clawback-enabled asset activity indicators: ${reasons.join(", ")}`,
      };
    },
  };
}

export default createClawbackActivityRule;
