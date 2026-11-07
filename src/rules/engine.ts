/**
 * Pluggable rules engine framework (issue #25).
 *
 * This engine is what makes rules "usable together" with the statistical
 * and ML tiers (README.md:32): every rule is a pure function of the merged
 * {@link FeatureMap} (#24) and the engine runs all enabled rules,
 * collects their signals, and applies weights for the shared aggregator
 * (#8). The rule registry (#38) composes on top of this base.
 *
 * Contract:
 * - A {@link Rule} is `{ id, weight, enabled?, evaluate }`. `weight` is the
 *   rule's declared contribution in [0, 1]; `enabled` defaults to true.
 * - `evaluate(context)` is pure: the same feature map always yields the
 *   same signal(s). It may return a single {@link Signal}, an array of
 *   signals, or null/undefined for "no signal".
 * - The engine normalizes both weights to [0, 1] and multiplies them:
 *   `effective = normalize(rule.weight) * normalize(signal.weight ?? 1)`.
 *   A rule that signals with weight 1 therefore contributes exactly its
 *   configured weight. Returning weight 0 contributes nothing (and the
 *   aggregator drops zero-weight entries).
 * - Rules are individually enable-able (`enabled` option map or
 *   `setEnabled`) and weight-configurable (`weights` option map or
 *   `setWeight`). Overrides are validated up front so typos fail loudly.
 * - `evaluate`/`run` returns signals in registration order, preserving
 *   each rule's internal order. Identical input yields identical output.
 * - A rule that throws propagates its error unchanged (fail fast).
 */

import { ValidationError } from "../errors.js";
import type { Signal } from "../types.js";
import type { FeatureMap } from "../features/types.js";
import {
  DEFAULT_SCORE_PRECISION,
  normalizeScore,
  roundToPrecision,
} from "../scoring/normalize.js";

/**
 * Input to {@link Rule.evaluate}: the uniform merged feature map (#24).
 *
 * Rules consume only this flat map (plus `accountId` when present as a
 * feature is not needed) so they stay pure functions for unit tests.
 */
export type RuleContext = FeatureMap;

/**
 * A single pluggable fraud rule (issue #25).
 *
 * ```ts
 * const rule: Rule = {
 *   id: "fresh-account",
 *   weight: 0.3,
 *   evaluate: (features) =>
 *     typeof features["accountAgeMs"] === "number" && features["accountAgeMs"] < 86400_000
 *       ? { id: "fresh-account", weight: 1, detail: "Account < 24h old" }
 *       : null,
 * };
 * ```
 */
export interface Rule {
  /** Stable rule id, also the default signal id. */
  readonly id: string;
  /**
   * Declared contribution of this rule in [0, 1]. Out-of-range values are
   * normalized via {@link normalizeScore}; non-numeric values contribute 0.
   */
  readonly weight: number;
  /** Whether the rule runs. Defaults to true. */
  readonly enabled?: boolean;
  /**
   * Evaluates the rule against the merged feature map. Pure with respect
   * to its context. Return null/undefined for no signal.
   */
  evaluate(context: RuleContext): Signal | readonly Signal[] | null | undefined;
}

/** Options for {@link RuleEngine}. */
export interface RuleEngineOptions {
  /**
   * Rules to run, in output order. Defaults to {@link createDefaultRules}.
   */
  readonly rules?: readonly Rule[];
  /**
   * Per-rule enablement by rule id. Omitted entries default to their
   * `enabled` flag (itself defaulting to true). Unknown ids are rejected.
   */
  readonly enabled?: Readonly<Record<string, boolean>>;
  /**
   * Per-rule weight overrides by rule id, in [0, 1]. These win over
   * `rule.weight`. Unknown ids are rejected; non-finite or out-of-range
   * values are normalized deterministically.
   */
  readonly weights?: Readonly<Record<string, number>>;
}

function resolveRuleId(rule: Rule, index: number): string {
  if (!rule || typeof rule !== "object") {
    throw new ValidationError(
      `Rule at index ${index} must be an object with id, weight, and evaluate method`
    );
  }
  if (typeof rule.id !== "string" || rule.id.trim().length === 0) {
    throw new ValidationError(
      `Rule at index ${index} must have a non-empty string id`
    );
  }
  if (typeof rule.evaluate !== "function") {
    throw new ValidationError(
      `Rule "${rule.id}" must implement evaluate(context): Signal | Signal[] | null`
    );
  }
  return rule.id;
}

function resolveWeight(value: number, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ValidationError(`${label} must be a finite number`);
  }
  return value;
}

/**
 * Totally pure rule engine (#25): runs all enabled rules uniformly and
 * applies weights for the aggregator (#8).
 */
export class RuleEngine {
  private readonly rules = new Map<string, Rule>();
  private readonly enabledMap = new Map<string, boolean>();
  private readonly weightOverrides = new Map<string, number>();

  constructor(options: RuleEngineOptions = {}) {
    const rules = options.rules ?? createDefaultRules();
    rules.forEach((rule, index) => {
      const id = resolveRuleId(rule, index);
      if (this.rules.has(id)) {
        throw new ValidationError(`Duplicate rule "${id}"`);
      }
      this.rules.set(id, rule);
      this.enabledMap.set(id, rule.enabled ?? true);
    });

    if (options.enabled !== undefined) {
      if (
        !options.enabled ||
        typeof options.enabled !== "object" ||
        Array.isArray(options.enabled)
      ) {
        throw new ValidationError(
          "enabled must be a record mapping rule ids to booleans"
        );
      }
      for (const [id, enabled] of Object.entries(options.enabled)) {
        if (!this.rules.has(id)) {
          throw new ValidationError(
            `Unknown rule "${id}" in enabled config. ` +
              `Registered rules: ${this.ruleIds().join(", ") || "(none)"}`
          );
        }
        if (typeof enabled !== "boolean") {
          throw new ValidationError(
            `enabled["${id}"] must be a boolean, got ${typeof enabled}`
          );
        }
        this.enabledMap.set(id, enabled);
      }
    }

    if (options.weights !== undefined) {
      if (
        !options.weights ||
        typeof options.weights !== "object" ||
        Array.isArray(options.weights)
      ) {
        throw new ValidationError(
          "weights must be a record mapping rule ids to numbers"
        );
      }
      for (const [id, weight] of Object.entries(options.weights)) {
        if (!this.rules.has(id)) {
          throw new ValidationError(
            `Unknown rule "${id}" in weights config. ` +
              `Registered rules: ${this.ruleIds().join(", ") || "(none)"}`
          );
        }
        resolveWeight(weight, `weights["${id}"]`);
        this.weightOverrides.set(id, weight);
      }
    }
  }

  /** All registered rules in registration (output) order. */
  listRules(): Rule[] {
    return Array.from(this.rules.values());
  }

  /** Ids of all registered rules in registration order. */
  ruleIds(): string[] {
    return Array.from(this.rules.keys());
  }

  /** Returns true when a rule with this exact id is registered. */
  hasRule(id: string): boolean {
    return this.rules.has(id);
  }

  /** Returns the rule with this id, or undefined when absent. */
  getRule(id: string): Rule | undefined {
    return this.rules.get(id);
  }

  /**
   * Registers another rule.
   *
   * @returns This engine, for chaining.
   * @throws {ValidationError} If the rule is malformed or its id collides.
   */
  register(rule: Rule): this {
    const id = resolveRuleId(rule, this.rules.size);
    if (this.rules.has(id)) {
      throw new ValidationError(`Duplicate rule "${id}"`);
    }
    this.rules.set(id, rule);
    this.enabledMap.set(id, rule.enabled ?? true);
    return this;
  }

  /**
   * Removes a rule and its enable/weight overrides.
   *
   * @returns True when a rule was removed, false when absent.
   */
  unregister(id: string): boolean {
    const removed = this.rules.delete(id);
    if (removed) {
      this.enabledMap.delete(id);
      this.weightOverrides.delete(id);
    }
    return removed;
  }

  /** Returns whether the named rule is currently enabled. */
  isEnabled(id: string): boolean {
    if (!this.rules.has(id)) {
      throw new ValidationError(
        `Unknown rule "${id}". Registered rules: ${
          this.ruleIds().join(", ") || "(none)"
        }`
      );
    }
    return this.enabledMap.get(id) ?? true;
  }

  /**
   * Enables or disables a single rule at runtime.
   *
   * @throws {ValidationError} If the id is unknown or `enabled` is not a boolean.
   */
  setEnabled(id: string, enabled: boolean): void {
    if (!this.rules.has(id)) {
      throw new ValidationError(
        `Unknown rule "${id}". Registered rules: ${
          this.ruleIds().join(", ") || "(none)"
        }`
      );
    }
    if (typeof enabled !== "boolean") {
      throw new ValidationError(
        `enabled for "${id}" must be a boolean, got ${typeof enabled}`
      );
    }
    this.enabledMap.set(id, enabled);
  }

  /** Effective configured weight for a rule (override wins over rule.weight). */
  getWeight(id: string): number {
    if (!this.rules.has(id)) {
      throw new ValidationError(
        `Unknown rule "${id}". Registered rules: ${
          this.ruleIds().join(", ") || "(none)"
        }`
      );
    }
    return this.weightOverrides.get(id) ?? this.rules.get(id)?.weight ?? 0;
  }

  /**
   * Overrides the configured weight for a single rule at runtime.
   *
   * @throws {ValidationError} If the id is unknown or the weight is not finite.
   */
  setWeight(id: string, weight: number): void {
    if (!this.rules.has(id)) {
      throw new ValidationError(
        `Unknown rule "${id}". Registered rules: ${
          this.ruleIds().join(", ") || "(none)"
        }`
      );
    }
    resolveWeight(weight, `weight for "${id}"`);
    this.weightOverrides.set(id, weight);
  }

  /** Enabled rules in registration order. */
  enabledRules(): Rule[] {
    return this.listRules().filter((rule) => this.enabledMap.get(rule.id));
  }

  /**
   * Runs every enabled rule against the merged feature map and collects
   * weighted signals for the aggregator (#8).
   *
   * Rules receive the exact same {@link FeatureMap} object from #24. The
   * effective weight is `normalize(ruleWeight) * normalize(signalWeight ?? 1)`
   * rounded to the shared score precision. A signal with an empty id is
   * dropped (the aggregator requires a machine-readable id); everything
   * else is emitted in registration order.
   *
   * @param context - Merged feature map from the registry (#24).
   * @returns Weighted signals ready for `aggregate`.
   * @throws {ValidationError} If the context is not an object.
   */
  evaluate(context: RuleContext): Signal[] {
    if (!context || typeof context !== "object" || Array.isArray(context)) {
      throw new ValidationError("Rule context must be a FeatureMap object from #24");
    }
    const signals: Signal[] = [];
    for (const rule of this.enabledRules()) {
      const produced = rule.evaluate(context);
      if (produced === null || produced === undefined) {
        continue;
      }
      const list: readonly Signal[] = Array.isArray(produced)
        ? (produced as readonly Signal[])
        : [produced as Signal];
      const ruleWeight = normalizeScore(
        this.weightOverrides.get(rule.id) ?? rule.weight,
        DEFAULT_SCORE_PRECISION
      );
      for (const signal of list) {
        if (
          !signal ||
          typeof signal.id !== "string" ||
          signal.id.trim().length === 0
        ) {
          continue;
        }
        const rawWeight = (signal as { weight?: number }).weight;
        const scale =
          typeof rawWeight !== "number" ? 1 : normalizeScore(rawWeight);
        const effective = normalizeScore(ruleWeight * scale);
        signals.push({
          id: signal.id,
          weight: roundToPrecision(effective, DEFAULT_SCORE_PRECISION),
          detail: signal.detail,
        });
      }
    }
    return signals;
  }

  /** Alias for {@link RuleEngine.evaluate}. */
  run(context: RuleContext): Signal[] {
    return this.evaluate(context);
  }
}

/** Creates a {@link RuleEngine} from engine options. */
export function createRuleEngine(options: RuleEngineOptions = {}): RuleEngine {
  return new RuleEngine(options);
}

/**
 * Validates rule input as a {@link Rule} (helper for `register` callers).
 *
 * @throws {ValidationError} If id/evaluate are missing or the weight is not finite.
 */
export function createRule(rule: Rule): Rule {
  resolveRuleId(rule, 0);
  resolveWeight(rule.weight, `weight for rule "${rule.id}"`);
  return rule;
}

/* ------------------------------------------------------------------ */
/* Built-in example rules (mirrors FraudDetector.runRuleDetectors)     */
/* ------------------------------------------------------------------ */

/**
 * Illustrative fresh-account rule: account younger than 24 hours.
 *
 * Consumes `accountAgeMs` from the lifecycle provider (#23 via #24).
 * Weight matches FraudDetector's legacy `fresh-account` (0.3).
 */
export function createFreshAccountRule(weight = 0.3): Rule {
  resolveWeight(weight, "weight for rule \"fresh-account\"");
  return {
    id: "fresh-account",
    weight,
    evaluate(context: RuleContext): Signal | null {
      const ageMs = context["accountAgeMs"];
      if (typeof ageMs === "number" && Number.isFinite(ageMs) && ageMs < 86_400_000) {
        return {
          id: "fresh-account",
          weight: 1,
          detail: "Account created less than 24 hours ago",
        };
      }
      return null;
    },
  };
}

/**
 * Illustrative rapid-fan-out rule: most transactions pay a distinct counterparty.
 *
 * Consumes `graphOutDegree` (#20) and `velocityTotalCount` (#19) from the
 * registry (#24) as `graphOutDegree / max(1, velocityTotalCount)`.
 * Weight matches FraudDetector's legacy `rapid-fan-out` (0.6).
 */
export function createRapidFanOutRule(weight = 0.6): Rule {
  resolveWeight(weight, "weight for rule \"rapid-fan-out\"");
  return {
    id: "rapid-fan-out",
    weight,
    evaluate(context: RuleContext): Signal | null {
      const outDegree = context["graphOutDegree"];
      const total = context["velocityTotalCount"];
      if (
        typeof outDegree !== "number" ||
        typeof total !== "number" ||
        !Number.isFinite(outDegree) ||
        !Number.isFinite(total) ||
        total <= 0
      ) {
        return null;
      }
      const ratio = outDegree / Math.max(1, total);
      if (ratio > 0.8) {
        return {
          id: "rapid-fan-out",
          weight: 1,
          detail: "Account sends to many counterparties in short time",
        };
      }
      return null;
    },
  };
}

/**
 * Illustrative high-velocity rule: burst of transactions in the last hour.
 *
 * Consumes `txCount1h` from the velocity provider (#19 via #24).
 * Weight matches FraudDetector's legacy `high-velocity` (0.5).
 */
export function createHighVelocityRule(weight = 0.5): Rule {
  resolveWeight(weight, "weight for rule \"high-velocity\"");
  return {
    id: "high-velocity",
    weight,
    evaluate(context: RuleContext): Signal | null {
      const count = context["txCount1h"];
      if (typeof count !== "number" || !Number.isFinite(count)) {
        return null;
      }
      if (count >= 10) {
        return {
          id: "high-velocity",
          weight: 1,
          detail: "Unusually high transaction frequency",
        };
      }
      return null;
    },
  };
}

/** The three illustrative starting-point rules for the engine. */
export function createDefaultRules(): Rule[] {
  return [
    createRapidFanOutRule(),
    createHighVelocityRule(),
    createFreshAccountRule(),
  ];
}

/** Creates a {@link RuleEngine} pre-loaded with the default rules. */
export function createDefaultRuleEngine(
  options: RuleEngineOptions = {}
): RuleEngine {
  return new RuleEngine({
    rules: options.rules ?? createDefaultRules(),
    enabled: options.enabled,
    weights: options.weights,
  });
}
