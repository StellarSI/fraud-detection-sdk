/**
 * Statistical anomaly detection (issue #41).
 *
 * Implements robust z-score and IQR-based outlier detection over numeric
 * feature vectors. Emits a `statistical-anomaly` signal naming the driving
 * feature when a value is an outlier.
 */

import type { FeatureMap, FeatureValue } from "../features/types.js";
import type { Signal } from "../types.js";
import { ValidationError } from "../errors.js";

export interface StatisticalDetectorOptions {
  /** Robust z-score threshold in median absolute deviations. Default: 3.5. */
  readonly modifiedZThreshold?: number;
  /** IQR multiplier for fence calculation. Default: 1.5. */
  readonly iqrMultiplier?: number;
  /** Minimum sample size before statistical detection runs. Default: 4. */
  readonly minSamples?: number;
  /**
   * Sensitivity multiplier applied to configured thresholds. Values > 1 make
   * detection more sensitive; values in (0, 1] make it less sensitive.
   * Default: 1.
   */
  readonly sensitivity?: number;
}

export interface StatisticalDetectionResult {
  readonly signals: Signal[];
  readonly anomalies: Array<{
    feature: string;
    value: number;
    median: number;
    mad: number;
    modifiedZScore: number;
    q1: number;
    q3: number;
    iqr: number;
    isZScoreOutlier: boolean;
    isIqrOutlier: boolean;
  }>;
}

const DEFAULT_MODIFIED_Z_THRESHOLD = 3.5;
const DEFAULT_IQR_MULTIPLIER = 1.5;
const DEFAULT_MIN_SAMPLES = 4;
const DEFAULT_SENSITIVITY = 1;

function isFiniteNumber(value: FeatureValue | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function quantile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const pos = (sorted.length - 1) * p;
  const lower = Math.floor(pos);
  const upper = Math.min(lower + 1, sorted.length - 1);
  const weight = pos - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return quantile(sorted, 0.5);
}

function medianAbsoluteDeviation(values: readonly number[], med: number): number {
  return median(values.map((v) => Math.abs(v - med)));
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

export class StatisticalAnomalyDetector {
  private readonly modifiedZThreshold: number;
  private readonly iqrMultiplier: number;
  private readonly minSamples: number;
  private readonly sensitivity: number;

  constructor(options: StatisticalDetectorOptions = {}) {
    const sensitivity = options.sensitivity ?? DEFAULT_SENSITIVITY;
    if (!Number.isFinite(sensitivity) || sensitivity <= 0) {
      throw new ValidationError("sensitivity must be a positive finite number");
    }
    const modifiedZThreshold = options.modifiedZThreshold ?? DEFAULT_MODIFIED_Z_THRESHOLD;
    const iqrMultiplier = options.iqrMultiplier ?? DEFAULT_IQR_MULTIPLIER;
    const minSamples = options.minSamples ?? DEFAULT_MIN_SAMPLES;
    if (!Number.isFinite(modifiedZThreshold) || modifiedZThreshold <= 0) {
      throw new ValidationError("modifiedZThreshold must be a positive finite number");
    }
    if (!Number.isFinite(iqrMultiplier) || iqrMultiplier <= 0) {
      throw new ValidationError("iqrMultiplier must be a positive finite number");
    }
    if (!Number.isInteger(minSamples) || minSamples < 1) {
      throw new ValidationError("minSamples must be a positive integer");
    }
    this.sensitivity = sensitivity;
    this.modifiedZThreshold = modifiedZThreshold / sensitivity;
    this.iqrMultiplier = iqrMultiplier / sensitivity;
    this.minSamples = minSamples;
  }

  /**
   * Detect anomalies in a single feature vector against a population/sample.
   *
   * `samples` should contain numeric values for the same feature across the
   * observed population/window. `current` is the value being evaluated.
   */
  detectFeature(feature: string, current: number, samples: readonly number[]): StatisticalDetectionResult["anomalies"][number] | null {
    if (!feature || typeof feature !== "string") {
      throw new ValidationError("feature must be a non-empty string");
    }
    if (!Number.isFinite(current)) {
      throw new ValidationError(`current value for ${feature} must be a finite number`);
    }
    const cleanSamples = samples.filter((v) => Number.isFinite(v));
    if (cleanSamples.length < this.minSamples) return null;

    const sorted = [...cleanSamples].sort((a, b) => a - b);
    const med = median(sorted);
    const mad = medianAbsoluteDeviation(sorted, med);
    const q1 = quantile(sorted, 0.25);
    const q3 = quantile(sorted, 0.75);
    const iqr = q3 - q1;

    let modifiedZScore = 0;
    let isZScoreOutlier = false;
    if (mad === 0) {
      // Zero variance: any different value is maximally unusual; same value is normal.
      if (current !== med) {
        modifiedZScore = Number.POSITIVE_INFINITY;
        isZScoreOutlier = true;
      }
    } else {
      // 0.6745 scales MAD to be consistent with std dev for normal distributions.
      modifiedZScore = (0.6745 * (current - med)) / mad;
      isZScoreOutlier = Math.abs(modifiedZScore) >= this.modifiedZThreshold;
    }

    let isIqrOutlier = false;
    if (iqr === 0) {
      if (current !== med) isIqrOutlier = true;
    } else {
      const lower = q1 - this.iqrMultiplier * iqr;
      const upper = q3 + this.iqrMultiplier * iqr;
      isIqrOutlier = current < lower || current > upper;
    }

    if (!isZScoreOutlier && !isIqrOutlier) return null;
    return { feature, value: current, median: med, mad, modifiedZScore, q1, q3, iqr, isZScoreOutlier, isIqrOutlier };
  }

  /**
   * Evaluate a feature map against per-feature baseline samples.
   */
  evaluate(
    features: FeatureMap,
    baselineSamples: Readonly<Record<string, readonly number[]>>,
  ): StatisticalDetectionResult {
    if (!features || typeof features !== "object" || Array.isArray(features)) {
      throw new ValidationError("features must be a FeatureMap object");
    }
    if (!baselineSamples || typeof baselineSamples !== "object" || Array.isArray(baselineSamples)) {
      throw new ValidationError("baselineSamples must be a record of numeric arrays");
    }

    const anomalies: StatisticalDetectionResult["anomalies"] = [];
    for (const [feature, samples] of Object.entries(baselineSamples)) {
      const value = features[feature];
      if (!isFiniteNumber(value)) continue;
      if (!Array.isArray(samples)) continue;
      const anomaly = this.detectFeature(feature, value, samples);
      if (anomaly) anomalies.push(anomaly);
    }

    anomalies.sort((a, b) => {
      const az = Number.isFinite(Math.abs(a.modifiedZScore)) ? Math.abs(a.modifiedZScore) : Number.MAX_SAFE_INTEGER;
      const bz = Number.isFinite(Math.abs(b.modifiedZScore)) ? Math.abs(b.modifiedZScore) : Number.MAX_SAFE_INTEGER;
      if (bz !== az) return bz - az;
      return a.feature.localeCompare(b.feature);
    });

    const signals: Signal[] = anomalies.map((a) => {
      const zFactor = Number.isFinite(Math.abs(a.modifiedZScore))
        ? Math.min(Math.abs(a.modifiedZScore) / (this.modifiedZThreshold * 2), 1)
        : 1;
      const iqrFactor = a.iqr > 0 ? Math.min(Math.abs(a.value - a.median) / (a.iqr * this.iqrMultiplier * 2), 1) : (a.isIqrOutlier ? 1 : 0);
      const weight = clamp01(Math.max(zFactor, iqrFactor));
      const methods = [a.isZScoreOutlier ? "robust-z" : null, a.isIqrOutlier ? "iqr" : null].filter(Boolean).join(",");
      return {
        id: "statistical-anomaly",
        weight: Math.round(weight * 10_000) / 10_000,
        detail: `Statistical anomaly in ${a.feature}: value=${a.value}, median=${a.median}, mad=${a.mad}, q1=${a.q1}, q3=${a.q3}, methods=${methods}`,
      };
    });

    return { signals, anomalies };
  }
}

export function createStatisticalAnomalyDetector(
  options: StatisticalDetectorOptions = {},
): StatisticalAnomalyDetector {
  return new StatisticalAnomalyDetector(options);
}
