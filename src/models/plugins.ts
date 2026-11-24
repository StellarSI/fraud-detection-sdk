/**
 * Async adapters that make every model tier satisfy {@link ModelPlugin}
 * (issue #43).
 *
 * The rules (#25) and statistical (#41) tiers are synchronous by design;
 * wrapping them here keeps their existing `evaluate` API intact while giving
 * the scoring pipeline one uniform, promise-based `score(context)` contract.
 * The ML adapter is the bridge expected by the future ML tier (#49): any
 * function that maps features to a number can participate in aggregation
 * without changing the plugin interface.
 */

import { ValidationError } from "../errors.js";
import { extractFeatures } from "../features/registry.js";
import type { FeatureMap } from "../features/types.js";
import {
  createRuleEngine,
  type Rule,
  type RuleEngine,
} from "../rules/engine.js";
import type { Signal } from "../types.js";
import {
  StatisticalAnomalyDetector,
  type StatisticalDetectorOptions,
} from "./statistical.js";
import {
  isModelPlugin,
  type ModelContext,
  type ModelPlugin,
  type ModelPluginOptions,
} from "./types.js";

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function validateWeight(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new ValidationError(`${label} must be a finite number in [0, 1]`);
  }
  return value;
}

function scale(signal: Signal, weight: number): Signal {
  return { ...signal, weight: round4(Math.min(1, Math.max(0, signal.weight * weight))) };
}

function featuresOf(context: ModelContext): FeatureMap {
  return context.features ?? extractFeatures(context);
}

function applyCommonOptions(
  options: ModelPluginOptions,
  state: { enabled: boolean; weight: number },
): void {
  if (typeof options.enabled === "boolean") state.enabled = options.enabled;
  if (options.weight !== undefined) state.weight = validateWeight(options.weight, "weight");
}

/** Options for {@link createRulesModelPlugin}. */
export interface RulesModelPluginOptions {
  /** Plugin id. Defaults to `"rules"`. */
  readonly id?: string;
  /** Existing engine to adapt. A fresh engine is created when omitted. */
  readonly engine?: RuleEngine;
  /** Rules used when no engine is supplied. */
  readonly rules?: readonly Rule[];
}

/** Adapts the synchronous rules tier (#25) to the async plugin contract. */
export function createRulesModelPlugin(options: RulesModelPluginOptions = {}): ModelPlugin {
  const id = options.id ?? "rules";
  const engine = options.engine ?? createRuleEngine({ rules: options.rules });
  const state = { enabled: true, weight: 1 };

  return {
    id,
    async score(context: ModelContext): Promise<Signal[]> {
      if (!state.enabled) return [];
      return engine.evaluate(featuresOf(context)).map((signal) => scale(signal, state.weight));
    },
    configure(options: ModelPluginOptions): void {
      applyCommonOptions(options, state);
      const enabledRules = options.enabledRules;
      if (enabledRules !== undefined) {
        if (!enabledRules || typeof enabledRules !== "object" || Array.isArray(enabledRules)) {
          throw new ValidationError("enabledRules must be a record of rule ids to booleans");
        }
        for (const [ruleId, value] of Object.entries(enabledRules)) {
          if (typeof value !== "boolean") {
            throw new ValidationError(`enabledRules["${ruleId}"] must be a boolean`);
          }
          engine.setEnabled(ruleId, value);
        }
      }
      const ruleWeights = options.ruleWeights;
      if (ruleWeights !== undefined) {
        if (!ruleWeights || typeof ruleWeights !== "object" || Array.isArray(ruleWeights)) {
          throw new ValidationError("ruleWeights must be a record of rule ids to numbers");
        }
        for (const [ruleId, value] of Object.entries(ruleWeights)) {
          engine.setWeight(ruleId, validateWeight(value, `ruleWeights["${ruleId}"]`));
        }
      }
    },
  };
}

/** Options for {@link createStatisticalModelPlugin}. */
export interface StatisticalModelPluginOptions extends StatisticalDetectorOptions {
  /** Plugin id. Defaults to `"statistical"`. */
  readonly id?: string;
}

/** Adapts the statistical tier (#41) to the async plugin contract. */
export function createStatisticalModelPlugin(
  options: StatisticalModelPluginOptions = {},
): ModelPlugin {
  const id = options.id ?? "statistical";
  const state = { enabled: true, weight: 1 };
  let detector = new StatisticalAnomalyDetector(options);

  return {
    id,
    async score(context: ModelContext): Promise<Signal[]> {
      if (!state.enabled) return [];
      const result = detector.evaluate(featuresOf(context), context.baselineSamples ?? {});
      return result.signals.map((signal) => scale(signal, state.weight));
    },
    configure(options: ModelPluginOptions): void {
      applyCommonOptions(options, state);
      const detectorKeys = [
        "modifiedZThreshold",
        "iqrMultiplier",
        "minSamples",
        "sensitivity",
      ] as const;
      const changed = detectorKeys.some((key) => options[key] !== undefined);
      if (changed) {
        const next: StatisticalDetectorOptions = {};
        for (const key of detectorKeys) {
          const value = options[key];
          if (value !== undefined) {
            if (typeof value !== "number") {
              throw new ValidationError(`${key} must be a positive finite number`);
            }
            (next as Record<string, number>)[key] = value;
          }
        }
        detector = new StatisticalAnomalyDetector(next);
      }
    },
  };
}

/** A predictor mapping features to a single risk contribution in [0, 1]. */
export type MLPredict = (features: FeatureMap) => number | Promise<number>;

/** Options for {@link createMLModelPlugin}. */
export interface MLModelPluginOptions {
  /** Plugin id. Defaults to `"ml"`. */
  readonly id?: string;
  /** Model version included in signal details for reproducibility (#49). */
  readonly version?: string;
  /** Prediction function. */
  readonly predict: MLPredict;
  /** Minimum prediction that emits a signal. Defaults to 0. */
  readonly threshold?: number;
}

/**
 * Bridges any ML model (#49) into the unified plugin contract. A number is
 * turned into one weighted signal so ML predictions aggregate identically
 * to rule and statistical signals.
 */
export function createMLModelPlugin(options: MLModelPluginOptions): ModelPlugin {
  if (!options || typeof options.predict !== "function") {
    throw new ValidationError("ML model plugin requires a predict(features) function");
  }
  const id = options.id ?? "ml";
  let version = options.version ?? "unversioned";
  const state = { enabled: true, weight: 1 };
  let threshold = validateWeight(options.threshold ?? 0, "threshold");

  return {
    id,
    async score(context: ModelContext): Promise<Signal[]> {
      if (!state.enabled) return [];
      const prediction = await options.predict(featuresOf(context));
      if (typeof prediction !== "number" || !Number.isFinite(prediction) || prediction < 0) {
        throw new ValidationError(`ML model "${id}" must predict a non-negative finite number`);
      }
      if (prediction < threshold) return [];
      return [
        scale(
          {
            id: `${id}-prediction`,
            weight: round4(Math.min(1, prediction)),
            detail: `ML model ${id}@${version} predicted ${prediction}`,
          },
          state.weight,
        ),
      ];
    },
    configure(options: ModelPluginOptions): void {
      applyCommonOptions(options, state);
      if (options.threshold !== undefined) {
        threshold = validateWeight(options.threshold, "threshold");
      }
      if (options.version !== undefined) {
        if (typeof options.version !== "string" || options.version.trim().length === 0) {
          throw new ValidationError("version must be a non-empty string");
        }
        version = options.version;
      }
    },
  };
}

/** Runs every enabled plugin and merges its signals deterministically. */
export class ModelPluginRegistry {
  private readonly plugins = new Map<string, ModelPlugin>();
  private readonly enabled = new Map<string, boolean>();

  constructor(plugins: readonly ModelPlugin[] = []) {
    for (const plugin of plugins) this.register(plugin);
  }

  register(plugin: ModelPlugin): this {
    if (!isModelPlugin(plugin)) {
      throw new ValidationError("plugin must implement id, score and configure");
    }
    if (this.plugins.has(plugin.id)) {
      throw new ValidationError(`Duplicate model plugin "${plugin.id}"`);
    }
    this.plugins.set(plugin.id, plugin);
    this.enabled.set(plugin.id, true);
    return this;
  }

  list(): ModelPlugin[] {
    return Array.from(this.plugins.values());
  }

  pluginIds(): string[] {
    return Array.from(this.plugins.keys());
  }

  get(id: string): ModelPlugin | undefined {
    return this.plugins.get(id);
  }

  setEnabled(id: string, enabled: boolean): void {
    if (!this.plugins.has(id)) throw new ValidationError(`Unknown model plugin "${id}"`);
    if (typeof enabled !== "boolean") throw new ValidationError("enabled must be a boolean");
    this.enabled.set(id, enabled);
  }

  isEnabled(id: string): boolean {
    if (!this.plugins.has(id)) throw new ValidationError(`Unknown model plugin "${id}"`);
    return this.enabled.get(id) ?? false;
  }

  async score(context: ModelContext): Promise<Signal[]> {
    const signals: Signal[] = [];
    for (const plugin of this.plugins.values()) {
      if (!this.enabled.get(plugin.id)) continue;
      signals.push(...(await plugin.score(context)));
    }
    return signals;
  }
}

/** Convenience factory for {@link ModelPluginRegistry}. */
export function createModelPluginRegistry(plugins: readonly ModelPlugin[] = []): ModelPluginRegistry {
  return new ModelPluginRegistry(plugins);
}
