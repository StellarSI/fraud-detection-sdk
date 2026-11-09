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

export {
  DEFAULT_TRUSTLINE_ABUSE_RULE_WEIGHT,
  DEFAULT_TRUSTLINE_ABUSE_MIN_SCORE,
  DEFAULT_TRUSTLINE_ABUSE_EXTREME_COUNT,
  DEFAULT_TRUSTLINE_ABUSE_BURST_THRESHOLD,
  DEFAULT_TRUSTLINE_ABUSE_DUST_RATIO,
  DEFAULT_TRUSTLINE_ABUSE_SPAM_ISSUERS,
  createTrustlineAbuseRule,
} from "./trustlineAbuse.js";
export type { TrustlineAbuseRuleOptions } from "./trustlineAbuse.js";
