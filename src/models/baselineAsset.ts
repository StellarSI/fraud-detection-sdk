/**
 * Per-asset behavioral baseline (issue #40).
 *
 * Computes normal activity baselines per asset and emits deviation signals
 * when an account's current asset behavior is anomalous for that asset.
 */

import type { Signal } from "../types.js";
import type { Rule, RuleContext } from "../rules/engine.js";

export interface AssetBaselineStats {
  readonly count: number;
  readonly mean: number;
  readonly m2: number;
}

export interface AssetBaselineSnapshot {
  readonly asset: string;
  readonly observationCount: number;
  readonly volume: AssetBaselineStats;
  readonly velocity: AssetBaselineStats;
  readonly participantCount: AssetBaselineStats;
  readonly updatedAt: string;
}

/** Minimal persistence abstraction shared with #42. */
export interface BaselineStore<T = unknown> {
  get(key: string): T | undefined | Promise<T | undefined>;
  put(key: string, value: T): void | Promise<void>;
  set?(key: string, value: T): void | Promise<void>;
  delete(key: string): void | Promise<void>;
}

export class InMemoryBaselineStore<T = unknown> implements BaselineStore<T> {
  private readonly store = new Map<string, T>();
  get(key: string): T | undefined { return this.store.get(key); }
  put(key: string, value: T): void { this.store.set(key, value); }
  set(key: string, value: T): void { this.store.set(key, value); }
  delete(key: string): void { this.store.delete(key); }
}

export interface BaselineAssetOptions {
  readonly store?: BaselineStore<AssetBaselineSnapshot>;
  readonly minObservations?: number;
  readonly deviationThreshold?: number;
}

function emptyStats(): AssetBaselineStats { return { count: 0, mean: 0, m2: 0 }; }
function updateStats(stats: AssetBaselineStats, value: number): AssetBaselineStats {
  const count = stats.count + 1;
  const delta = value - stats.mean;
  const mean = stats.mean + delta / count;
  const m2 = stats.m2 + delta * (value - mean);
  return { count, mean, m2 };
}
function stdDev(stats: AssetBaselineStats): number {
  return stats.count < 2 ? 0 : Math.sqrt(stats.m2 / (stats.count - 1));
}
function zScore(stats: AssetBaselineStats, value: number): number {
  const sd = stdDev(stats);
  const delta = Math.abs(value - stats.mean);
  if (sd <= 0) return delta === 0 ? 0 : Number.POSITIVE_INFINITY;
  return delta / sd;
}
function num(context: RuleContext, key: string): number {
  const value = context[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
function str(context: RuleContext, key: string): string | undefined {
  const value = context[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export const DEFAULT_ASSET_BASELINE_MIN_OBSERVATIONS = 2;
export const DEFAULT_ASSET_BASELINE_DEVIATION_THRESHOLD = 2;
export const DEFAULT_BASELINE_ASSET_RULE_WEIGHT = 0.5;

export class BaselineAsset {
  private readonly store: BaselineStore<AssetBaselineSnapshot>;
  private readonly minObservations: number;
  private readonly deviationThreshold: number;
  private readonly stats = new Map<string, { volume: AssetBaselineStats; velocity: AssetBaselineStats; participantCount: AssetBaselineStats }>();

  constructor(options: BaselineAssetOptions = {}) {
    this.store = options.store ?? new InMemoryBaselineStore<AssetBaselineSnapshot>();
    this.minObservations = options.minObservations ?? DEFAULT_ASSET_BASELINE_MIN_OBSERVATIONS;
    this.deviationThreshold = options.deviationThreshold ?? DEFAULT_ASSET_BASELINE_DEVIATION_THRESHOLD;
  }

  record(asset: string, features: RuleContext): void {
    const key = asset.trim();
    if (!key) return;
    const current = this.stats.get(key) ?? { volume: emptyStats(), velocity: emptyStats(), participantCount: emptyStats() };
    const next = {
      volume: updateStats(current.volume, num(features, "assetVolume")),
      velocity: updateStats(current.velocity, num(features, "velocityTotalCount")),
      participantCount: updateStats(current.participantCount, num(features, "graphOutDegree")),
    };
    this.stats.set(key, next);
    const snapshot: AssetBaselineSnapshot = {
      asset: key,
      observationCount: next.volume.count,
      volume: next.volume,
      velocity: next.velocity,
      participantCount: next.participantCount,
      updatedAt: new Date().toISOString(),
    };
    void this.store.put(key, snapshot);
  }

  evaluate(asset: string, features: RuleContext): Signal | null {
    const key = asset.trim();
    if (!key) return null;
    const stats = this.stats.get(key);
    if (!stats || stats.volume.count < this.minObservations) return null;
    const volumeZ = zScore(stats.volume, num(features, "assetVolume"));
    const velocityZ = zScore(stats.velocity, num(features, "velocityTotalCount"));
    const participantZ = zScore(stats.participantCount, num(features, "graphOutDegree"));
    const maxZ = Math.max(volumeZ, velocityZ, participantZ);
    if (maxZ < this.deviationThreshold) return null;
    const metric = maxZ === volumeZ ? "volume" : maxZ === velocityZ ? "velocity" : "participantCount";
    const weight = Math.min(Math.max(maxZ / (this.deviationThreshold * 2), 0), 1);
    return {
      id: "asset-baseline-deviation",
      weight: Math.round(weight * 10_000) / 10_000,
      detail: `Asset baseline deviation for ${key}: ${metric} deviates ${maxZ.toFixed(2)} standard deviations from the ${stats.volume.count}-observation baseline`,
    };
  }

  getBaseline(asset: string): AssetBaselineSnapshot | undefined | Promise<AssetBaselineSnapshot | undefined> {
    return this.store.get(asset);
  }
}

export interface BaselineAssetRuleOptions extends BaselineAssetOptions {
  readonly weight?: number;
  readonly asset?: string;
}

export function createBaselineAssetRule(options: BaselineAssetRuleOptions = {}): Rule & { record: (asset: string, features: RuleContext) => void } {
  const baseline = new BaselineAsset(options);
  const weight = options.weight ?? DEFAULT_BASELINE_ASSET_RULE_WEIGHT;
  return {
    id: "asset-baseline-deviation",
    weight,
    evaluate(context: RuleContext): Signal | null {
      const asset = str(context, "asset") ?? options.asset;
      if (!asset) return null;
      return baseline.evaluate(asset, context);
    },
    record: (asset: string, features: RuleContext) => baseline.record(asset, features),
  };
}
