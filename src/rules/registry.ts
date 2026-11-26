/**
 * Pluggable rule registry (issue #38).
 *
 * Composes the pluggable rules engine (#25) with every detector rule
 * (#26-#37) so rules are "usable together" (README.md:32): the registry
 * holds all rules and their configuration, supports enabling/disabling
 * and per-rule weight overrides, and exposes the active rule list for
 * introspection and documentation. New rules can be registered without
 * touching the engine (open/closed).
 *
 * Contract:
 * - Providers are registered by id; duplicate ids are rejected so the
 *   registry never silently drops or duplicates a rule.
 * * - Rules are individually toggle-able via the `enabled` option map or
 *   at runtime with {@link RuleRegistry.setEnabled}. Disabled rules are
 *   skipped before evaluation, so a disabled rule cannot throw or
 *   contribute signals.
 * * - Per-rule weight overrides win over a rule's declared weight and
 *   are validated up front so typos fail loudly.
 * * - `evaluate`/`run` runs every enabled rule through the engine (#25)
 *   and returns weighted signals in registration order, preserving each
 *   rule's internal order. Identical input yields identical output.
 * * - A rule that throws propagates its error unchanged (fail fast).
 */

import {
  RuleEngine,
  createRuleEngine,
  type Rule,
  type RuleContext,
} from "./engine.js";
import type { Signal } from "../types.js";
import { createPathPaymentLayeringRule } from "./pathPaymentLayering.js";
import { createTrustlineAbuseRule } from "./trustlineAbuse.js";
import { createThrowawayMergeRule } from "./throwawayMerge.js";
import { createDustingRule } from "./dusting.js";
import { createCreateAccountFundingRule } from "./createAccountFunding.js";
import { createClaimableBalanceAbuseRule } from "./claimableBalanceAbuse.js";
import { createUnsolicitedClaimSpamRule } from "./unsolicitedClaimSpam.js";
import { createReusedMemoIdRule } from "./reusedMemoId.js";
import { createAnchorAnomalyRule } from "./anchorAnomaly.js";
import { createMultisigAuthorizationRule } from "./multisigAuth.js";
import { createClawbackActivityRule } from "./clawbackActivity.js";
import { createFanInOutRule } from "./fanInOut.js";
import { createCounterpartyClusterRule } from "./counterpartyCluster.js";

/** Every detector rule (#26-#37, #44), registered by default. */
const DETECTOR_RULES: readonly Rule[] = [
  createPathPaymentLayeringRule(),
  createTrustlineAbuseRule(),
  createThrowawayMergeRule(),
  createDustingRule(),
  createCreateAccountFundingRule(),
  createClaimableBalanceAbuseRule(),
  createUnsolicitedClaimSpamRule(),
  createReusedMemoIdRule(),
  createAnchorAnomalyRule(),
  createMultisigAuthorizationRule(),
  createClawbackActivityRule(),
  createFanInOutRule(),
  createCounterpartyClusterRule(),
];

/** Options for {@link RuleRegistry}. */
export interface RuleRegistryOptions {
  /**
   * Rules to register, in output order. Defaults to every detector rule
   * (#26-#37).
   */
  readonly rules?: readonly Rule[];
  /**
   * Per-rule enablement by rule id. Omitted entries default to each
   * rule's `enabled` flag (itself defaulting to true). Unknown ids are
   * rejected so typos fail loudly.
   */
  readonly enabled?: Readonly<Record<string, boolean>>;
  /**
   * Per-rule weight overrides by rule id, in [0, 1]. These win over
   * `rule.weight`. Unknown ids are rejected; non-finite or out-of-range
   * values are normalized deterministically.
   */
  readonly weights?: Readonly<Record<string, number>>;
}

/** One registered rule's resolved configuration for snapshotting. */
export interface RuleRegistryEntry {
  /** Stable rule id, also the default signal id. */
  readonly id: string;
  /** Whether the rule is currently enabled. */
  readonly enabled: boolean;
  /** Effective weight in [0, 1] (override wins over rule.weight). */
  readonly weight: number;
}

/** A snapshot of the registry's current configuration. */
export interface RuleRegistrySnapshot {
  /** Every registered rule with its current enablement and weight. */
  readonly rules: ReadonlyArray<RuleRegistryEntry>;
}

/**
 * Registry that holds pluggable {@link Rule}s and their configuration
 * (#38).
 *
 * ```ts
 * const registry = createDefaultRuleRegistry({
 *   enabled: { "path-payment-layering": false },
 *   weights: { "multisig-authorization": 0.8 },
 * });
 * registry.setEnabled("dusting", false);
 * registry.setWeight("reused-memo-id", 0.2);
 * const signals = registry.evaluate(features);
 * ```
 */
export class RuleRegistry {
  private readonly engine: RuleEngine;

  constructor(options: RuleRegistryOptions = {}) {
    this.engine = createRuleEngine({
      rules: options.rules ?? DETECTOR_RULES,
      enabled: options.enabled,
      weights: options.weights,
    });
  }

  /** All registered rules in registration (output) order. */
  listRules(): Rule[] {
    return this.engine.listRules();
  }

  /** Ids of all registered rules in registration order. */
  ruleIds(): string[] {
    return this.engine.ruleIds();
  }

  /** Returns true when a rule with this exact id is registered. */
  hasRule(id: string): boolean {
    return this.engine.hasRule(id);
  }

  /** Returns the rule with this id, or undefined when absent. */
  getRule(id: string): Rule | undefined {
    return this.engine.getRule(id);
  }

  /**
   * Registers another rule.
   *
   * @returns This registry, for chaining.
   * @throws {ValidationError} If the rule is malformed or its id
   *   collides with a registered rule.
   */
  register(rule: Rule): this {
    this.engine.register(rule);
    return this;
  }

  /**
   * Removes a rule and its enable/weight overrides.
   *
   * @returns True when a rule was removed, false when absent.
   */
  unregister(id: string): boolean {
    return this.engine.unregister(id);
  }

  /** Returns whether the named rule is currently enabled. */
  isEnabled(id: string): boolean {
    return this.engine.isEnabled(id);
  }

  /**
   * Enables or disables a single rule at runtime.
   *
   * @throws {ValidationError} If the id is unknown or `enabled` is not
   *   a boolean.
   */
  setEnabled(id: string, enabled: boolean): void {
    this.engine.setEnabled(id, enabled);
  }

  /** Effective configured weight for a rule (override wins over rule.weight). */
  getWeight(id: string): number {
    return this.engine.getWeight(id);
  }

  /**
   * Overrides the configured weight for a single rule at runtime.
   *
   * @throws {ValidationError} If the id is unknown or the weight is not
   *   finite.
   */
  setWeight(id: string, weight: number): void {
    this.engine.setWeight(id, weight);
  }

  /** Enabled rules in registration order. */
  enabledRules(): Rule[] {
    return this.engine.enabledRules();
  }

  /** A snapshot of every registered rule with its current state. */
  snapshot(): RuleRegistrySnapshot {
    return {
      rules: this.engine.listRules().map((rule) => ({
        id: rule.id,
        enabled: this.engine.isEnabled(rule.id),
        weight: this.engine.getWeight(rule.id),
      })),
    };
  }

  /**
   * Runs every enabled rule against the merged feature map and collects
   * weighted signals for the aggregator (#8).
   *
   * @param context - Merged feature map from the registry (#24).
   * @returns Weighted signals ready for `aggregate`.
   * @throws {ValidationError} If the context is not an object.
   */
  evaluate(context: RuleContext): Signal[] {
    return this.engine.evaluate(context);
  }

  /** Alias for {@link RuleRegistry.evaluate}. */
  run(context: RuleContext): Signal[] {
    return this.engine.run(context);
  }
}

/** Creates a {@link RuleRegistry} from registry options. */
export function createRuleRegistry(options: RuleRegistryOptions = {}): RuleRegistry {
  return new RuleRegistry(options);
}

/**
 * Creates a registry pre-loaded with every detector rule (#26-#37, #44) and
 * optional per-rule toggles from `enabled`.
 */
export function createDefaultRuleRegistry(
  options: RuleRegistryOptions = {}
): RuleRegistry {
  return new RuleRegistry({
    rules: options.rules ?? DETECTOR_RULES,
    enabled: options.enabled,
    weights: options.weights,
  });
}
