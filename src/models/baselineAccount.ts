/**
 * Per-account behavioral baseline (issue #39).
 *
 * Baselines turn raw features into "normal for this account" references
 * (README.md:29), enabling per-account anomaly detection rather than
 * one-size-fits-all thresholds. A baseline captures typical velocity,
 * counterparty count, asset diversity, and trustline activity from an
 * account's history and emits a `baseline-deviation` signal when current
 * features deviate beyond configurable bounds (README.md:32, README.md:110).
 *
 * Baselines are persisted through a {@link BaselineStore} (the persistence
 * abstraction #42) so they survive restarts and can be shared across
 * detector instances. The default store is an in-memory map; swap in a
 * durable store once issue #42 lands.
 *
 * Contract:
 * - `record` updates the running mean and variance (Welford's online
 *   algorithm) for each feature from the latest feature map.
 * - `evaluate` computes the z-score deviation of each current feature
 *   from its baseline mean and emits a signal when the worst deviation
 *   exceeds the configured threshold.
 * - Baselines require at least `minObservations` observations before any
 *   signal is emitted, so fresh accounts stay quiet.
 * - All methods are synchronous so the rule composes through the pluggable
 *   rules engine (#25) and rule registry (#38).
 */

import type { Signal } from "../types.js";
import type { Rule, RuleContext } from "../rules/engine.js";

/** Running statistics for one baseline metric (Welford's online algorithm). */
export interface BaselineStats {
  /** Number of observations incorporated so far. */
  readonly count: number;
  /** Running mean. */
  readonly mean: number;
  /** Sum of squared differences from the mean. */
  readonly m2: number;
}

/** One account's baseline snapshot, persisted through {@link BaselineStore}. */
export interface BaselineSnapshot {
  readonly accountId: string;
  /** Number of observations incorporated into the baseline. */
  readonly observationCount: number;
  readonly velocity: BaselineStats;
  readonly counterpartyCount: BaselineStats;
  readonly assetDiversity: BaselineStats;
  readonly trustlineCount: BaselineStats;
  /** ISO-8601 reference time the snapshot was last updated. */
  readonly updatedAt: string;
}

/** Persistence abstraction for baseline snapshots (issue #42). */
export interface BaselineStore {
  /** Reads the baseline snapshot for an account, if any. */
  get(accountId: string): BaselineSnapshot | undefined;
  /** Persists a baseline snapshot for an account. */
  set(accountId: string, snapshot: BaselineSnapshot): void;
  /** Removes the baseline snapshot for an account. */
  delete(accountId: string): void;
}

/**
 * In-memory baseline store (default implementation of #42).
 *
 * Kept in memory so the rule composes synchronously through the rules
 * engine; swap in a durable store once the persistence abstraction is
 * fleshed out by issue #42.
 */
export class InMemoryBaselineStore implements BaselineStore {
  private readonly store = new Map<string, BaselineSnapshot>();

  get(accountId: string): BaselineSnapshot | undefined {
    return this.store.get(accountId);
  }

  set(accountId: string, snapshot: BaselineSnapshot): void {
    this.store.set(accountId, snapshot);
  }

  delete(accountId: string): void {
    this.store.delete(accountId);
  }
}

/** Options for {@link BaselineAccount}. */
export interface BaselineAccountOptions {
  /**
   * Persistence store for baseline snapshots (defaults to an in-memory
   * store). Swap in a durable implementation once issue #42 lands.
   */
  readonly store?: BaselineStore;
  /**
   * Minimum observations required before the baseline is considered
   * established enough to emit signals. Default: 2.
   */
  readonly minObservations?: number;
  /**
   * Deviation threshold (z-score) beyond which a signal is emitted.
   * Default: 2 (roughly a 95% confidence one-sided deviation).
   */
  readonly deviationThreshold?: number;
  /** Maximum age of a baseline observation before it is stale (ms). Default: 7 days. */
  readonly maxAgeMs?: number;
}

function emptyStats(): BaselineStats {
  return { count: 0, mean: 0, m2: 0 };
}

function updateStats(stats: BaselineStats, value: number): BaselineStats {
  const count = stats.count + 1;
  const delta = value - stats.mean;
  const mean = stats.mean + delta / count;
  const delta2 = value - mean;
  const m2 = stats.m2 + delta * delta2;
  return { count, mean, m2 };
}

function stdDev(stats: BaselineStats): number {
  if (stats.count < 2) return 0;
  return Math.sqrt(stats.m2 / (stats.count - 1));
}

function zScore(stats: BaselineStats, value: number): number {
  const sd = stdDev(stats);
  const delta = Math.abs(value - stats.mean);

  if (sd <= 0) {
    // Degenerate baseline: every observed value was identical. A different
    // current value is an unambiguous (maximally unusual) deviation, while
    // an unchanged value is perfectly normal. Avoid dividing by zero.
    return delta === 0 ? 0 : Number.POSITIVE_INFINITY;
  }

  return delta / sd;
}

function num(context: RuleContext, key: string): number {
  const value = context[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function formatMetric(name: string): string {
  return name
    .replace(/([A-Z])/g, " $1")
    .replace(/^./, (c) => c.toUpperCase());
}

/** Default rule weight (engine contribution) in [0, 1]. */
export const DEFAULT_BASELINE_RULE_WEIGHT = 0.5;

/** Default minimum observations required before the baseline emits signals. */
export const DEFAULT_BASELINE_MIN_OBSERVATIONS = 2;

/** Default deviation threshold (z-score) beyond which a signal is emitted. */
export const DEFAULT_BASELINE_DEVIATION_THRESHOLD = 2;

/** Default maximum age of a baseline observation before it is stale (7 days). */
export const DEFAULT_BASELINE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Per-account behavioral baseline.
 *
 * Maintains running statistics per account and per feature (velocity,
 * counterparty count, asset diversity, trustline count) and emits a
 * `baseline-deviation` signal when current features deviate beyond the
 * configured z-score threshold.
 */
export class BaselineAccount {
  private readonly store: BaselineStore;
  private readonly minObservations: number;
  private readonly deviationThreshold: number;
  private readonly maxAgeMs: number;
  private readonly stats = new Map<string, {
    velocity: BaselineStats;
    counterpartyCount: BaselineStats;
    assetDiversity: BaselineStats;
    trustlineCount: BaselineStats;
  }>();

  constructor(options: BaselineAccountOptions = {}) {
    this.store = options.store ?? new InMemoryBaselineStore();
    this.minObservations =
      options.minObservations === undefined
        ? DEFAULT_BASELINE_MIN_OBSERVATIONS
        : options.minObservations;
    this.deviationThreshold =
      options.deviationThreshold === undefined
        ? DEFAULT_BASELINE_DEVIATION_THRESHOLD
        : options.deviationThreshold;
    this.maxAgeMs =
      options.maxAgeMs === undefined
        ? DEFAULT_BASELINE_MAX_AGE_MS
        : options.maxAgeMs;
  }

  /**
   * Records one observation for ``accountId`` and updates the running
   * baseline statistics from the current feature map. Persists the
   * resulting snapshot through {@link BaselineStore}.
   */
  record(accountId: string, features: RuleContext): void {
    let stats = this.stats.get(accountId);
    if (!stats) {
      stats = {
        velocity: emptyStats(),
        counterpartyCount: emptyStats(),
        assetDiversity: emptyStats(),
        trustlineCount: emptyStats(),
      };
    }

    stats.velocity = updateStats(stats.velocity, num(features, "velocityTotalCount"));
    stats.counterpartyCount = updateStats(
      stats.counterpartyCount,
      num(features, "graphOutDegree")
    );
    stats.assetDiversity = updateStats(
      stats.assetDiversity,
      num(features, "assetDiversity")
    );
    stats.trustlineCount = updateStats(
      stats.trustlineCount,
      num(features, "assetTrustlineCount")
    );

    this.stats.set(accountId, stats);
    this.store.set(accountId, this.snapshot(accountId, stats));
  }

  /**
   * Evaluates the current features against the baseline for ``accountId``.
   *
   * Returns a `baseline-deviation` signal when the worst per-metric
   * z-score exceeds the deviation threshold, or null when there is not
   * enough history or nothing deviates.
   */
  evaluate(accountId: string, features: RuleContext): Signal | null {
    let stats = this.stats.get(accountId);
    if (!stats) {
      // Hydrate from the store so baselines persisted by another instance
      // can be evaluated without re-recording history.
      const snapshot = this.store.get(accountId);
      if (!snapshot) return null;
      stats = {
        velocity: snapshot.velocity,
        counterpartyCount: snapshot.counterpartyCount,
        assetDiversity: snapshot.assetDiversity,
        trustlineCount: snapshot.trustlineCount,
      };
      this.stats.set(accountId, stats);
    }
    if (stats.velocity.count < this.minObservations) return null;

    const velocityZ = zScore(stats.velocity, num(features, "velocityTotalCount"));
    const counterpartyZ = zScore(
      stats.counterpartyCount,
      num(features, "graphOutDegree")
    );
    const assetDiversityZ = zScore(
      stats.assetDiversity,
      num(features, "assetDiversity")
    );
    const trustlineZ = zScore(
      stats.trustlineCount,
      num(features, "assetTrustlineCount")
    );

    const maxZ = Math.max(velocityZ, counterpartyZ, assetDiversityZ, trustlineZ);
    if (maxZ < this.deviationThreshold) return null;

    const weight = Math.min(
      Math.max(maxZ / (this.deviationThreshold * 2), 0),
      1
    );

    const metric = this.topMetric(
      velocityZ,
      counterpartyZ,
      assetDiversityZ,
      trustlineZ
    );

    return {
      id: "baseline-deviation",
      weight: Math.round(Math.min(Math.max(weight, 0), 1) * 10_000) / 10_000,
      detail:
        `Baseline deviation: ${metric} deviates ${maxZ.toFixed(2)} ` +
        `standard deviations from the ${stats.velocity.count}-observation baseline`,
    };
  }

  /** Returns the current baseline snapshot for ``accountId``, if any. */
  getBaseline(accountId: string): BaselineSnapshot | undefined {
    return this.store.get(accountId);
  }

  /** Removes the baseline for ``accountId`` from both memory and the store. */
  delete(accountId: string): void {
    this.stats.delete(accountId);
    this.store.delete(accountId);
  }

  private topMetric(
    velocityZ: number,
    counterpartyZ: number,
    assetDiversityZ: number,
    trustlineZ: number
  ): string {
    const best = Math.max(
      velocityZ,
      counterpartyZ,
      assetDiversityZ,
      trustlineZ
    );
    if (best === velocityZ) return formatMetric("velocity");
    if (best === counterpartyZ) return formatMetric("counterpartyCount");
    if (best === assetDiversityZ) return formatMetric("assetDiversity");
    return formatMetric("trustlineCount");
  }

  private snapshot(
    accountId: string,
    stats: {
      velocity: BaselineStats;
      counterpartyCount: BaselineStats;
      assetDiversity: BaselineStats;
      trustlineCount: BaselineStats;
    }
  ): BaselineSnapshot {
    return {
      accountId,
      observationCount: stats.velocity.count,
      velocity: stats.velocity,
      counterpartyCount: stats.counterpartyCount,
      assetDiversity: stats.assetDiversity,
      trustlineCount: stats.trustlineCount,
      updatedAt: new Date().toISOString(),
    };
  }
}

/** Options for {@link createBaselineRule}. */
export interface BaselineRuleOptions extends BaselineAccountOptions {
  /** Base rule weight (engine contribution) in [0, 1]. */
  readonly weight?: number;
  /**
   * Default account id used when the rule context does not carry one.
   * When unset, the rule reads ``accountId`` from the feature context.
   */
  readonly accountId?: string;
}

/**
 * Creates the baseline deviation rule.
 *
 * Reads features produced by the feature registry (#24): `velocityTotalCount`,
 * `graphOutDegree`, `assetDiversity`, and `assetTrustlineCount`. Reads the
 * scored account from ``context.accountId`` (falling back to the configured
 * ``accountId``) and compares the current features against that account's
 * historical baseline. Emits a `baseline-deviation` signal when a feature
 * deviates beyond the configured z-score threshold.
 *
 * The returned rule also exposes ``record`` so callers can feed observations
 * directly into the underlying baseline (useful when composing through the
 * rules engine #25 or rule registry #38).
 */
export function createBaselineRule(options: BaselineRuleOptions = {}): Rule & {
  record: (accountId: string, features: RuleContext) => void;
} {
  const baseline = new BaselineAccount(options);
  const weight =
    options.weight === undefined
      ? DEFAULT_BASELINE_RULE_WEIGHT
      : options.weight;

  const rule = {
    id: "baseline-deviation",
    weight,
    evaluate(context: RuleContext): Signal | null {
      const accountId =
        typeof context.accountId === "string"
          ? context.accountId
          : options.accountId;
      if (!accountId) return null;
      return baseline.evaluate(accountId, context);
    },
    record: baseline.record.bind(baseline),
  };
  return rule;
}

export default createBaselineRule;
