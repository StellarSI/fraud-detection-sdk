/**
 * Path-payment layering detector rule (issue #26).
 *
 * Targets the Stellar-specific pattern where path payments obscure asset
 * origin or layer value through multiple hops (README.md). Consumes
 * path-payment layering features (#24/#26) and emits a
 * `path-payment-layering` signal whose weight scales with hop count and
 * frequency/severity.
 *
 * Greenfield rule created per issue #26; designed to run through the
 * pluggable rules engine (#25).
 */

import type { Signal } from "../types.js";
import type { Rule, RuleContext } from "./engine.js";
import { ValidationError } from "../errors.js";

export interface PathPaymentLayeringRuleOptions {
  /**
   * Base rule weight (engine contribution) in [0, 1].
   * The emitted signal weight scales by severity; the engine combines them.
   */
  readonly weight?: number;
  /** Minimum layering severity score required to emit a signal. Default: 0.05. */
  readonly minScore?: number;
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

function num(context: RuleContext, key: string): number {
  const value = context[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function bool(context: RuleContext, key: string): boolean {
  return context[key] === true;
}

/**
 * Creates the path-payment layering rule.
 *
 * The rule reads features produced by `extractPathPaymentLayeringFeatures`
 * / `createPathPaymentLayeringFeatureProvider` (#26): `pathPaymentCount`,
 * `pathPaymentMaxHops`, `pathPaymentLongChainCount`,
 * `pathPaymentCircularCount`, `pathPaymentRapidCount`,
 * `pathPaymentHasCircularFlow`, and `pathPaymentLayeringScore`.
 *
 * Severity (and thus signal weight) scales with hop count and frequency.
 * Long or circular hop chains and rapid successive path payments increase
 * the emitted weight.
 */
export function createPathPaymentLayeringRule(
  options: PathPaymentLayeringRuleOptions = {}
): Rule {
  const weight = resolveNumber(options.weight, 0.7, "weight");
  const minScore = resolveNumber(options.minScore, 0.05, "minScore");

  return {
    id: "path-payment-layering",
    weight,
    evaluate(context: RuleContext): Signal | null {
      const count = num(context, "pathPaymentCount");
      if (count <= 0) {
        return null;
      }

      const maxHops = num(context, "pathPaymentMaxHops");
      const longChains = num(context, "pathPaymentLongChainCount");
      const circular = num(context, "pathPaymentCircularCount");
      const rapid = num(context, "pathPaymentRapidCount");
      const hasCircularFlow = bool(context, "pathPaymentHasCircularFlow");
      const score = num(context, "pathPaymentLayeringScore");

      // Scale severity from features: hop count and frequency dominate.
      const hopScale = Math.min(maxHops / 5, 1);
      const freqScale = Math.min(count / 10 + rapid / 10, 1);
      const patternBoost =
        (longChains > 0 ? 0.15 : 0) +
        (circular > 0 || hasCircularFlow ? 0.2 : 0);
      const severity = Math.max(
        score,
        Math.min(hopScale * 0.45 + freqScale * 0.35 + patternBoost, 1)
      );

      if (severity < minScore) {
        return null;
      }

      const reasons: string[] = [];
      if (maxHops >= 2) {
        reasons.push(`max ${maxHops} intermediate hops`);
      }
      if (longChains > 0) {
        reasons.push(`${longChains} long-chained`);
      }
      if (circular > 0 || hasCircularFlow) {
        reasons.push("circular path/flow detected");
      }
      if (rapid > 0) {
        reasons.push(`${rapid} rapid successive`);
      }
      const detail =
        reasons.length > 0
          ? `Path-payment layering indicators: ${reasons.join(", ")} (${count} path payment(s))`
          : `Path-payment activity detected (${count} path payment(s))`;

      return {
        id: "path-payment-layering",
        weight: Math.round(Math.min(Math.max(severity, 0), 1) * 10_000) / 10_000,
        detail,
      };
    },
  };
}

export default createPathPaymentLayeringRule;
