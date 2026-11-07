/**
 * Pluggable rules engine (issues #25, #38).
 *
 * Re-exports the engine contracts plus the starting-point example rules
 * so consumers can import them from one place.
 */

export {
  RuleEngine,
  createRuleEngine,
  createDefaultRuleEngine,
  createRule,
  createFreshAccountRule,
  createRapidFanOutRule,
  createHighVelocityRule,
  createDefaultRules,
} from "./engine.js";
export type { Rule, RuleContext, RuleEngineOptions } from "./engine.js";

export { createPathPaymentLayeringRule } from "./pathPaymentLayering.js";
export type { PathPaymentLayeringRuleOptions } from "./pathPaymentLayering.js";
