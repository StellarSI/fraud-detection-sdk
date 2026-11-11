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

export {
  DEFAULT_THROWAWAY_MERGE_RULE_WEIGHT,
  DEFAULT_YOUNG_ACCOUNT_MAX_AGE_MS,
  DEFAULT_MAX_MS_TO_FIRST_MERGE,
  DEFAULT_MIN_MERGE_COUNT,
  DEFAULT_THROWAWAY_MERGE_MIN_SCORE,
  createThrowawayMergeRule,
} from "./throwawayMerge.js";
export type { ThrowawayMergeRuleOptions } from "./throwawayMerge.js";

export {
  DEFAULT_DUSTING_RULE_WEIGHT,
  DEFAULT_DUSTING_RECIPIENT_THRESHOLD,
  DEFAULT_DUSTING_PAYMENT_THRESHOLD,
  DEFAULT_DUSTING_MIN_SCORE,
  DEFAULT_LEGITIMATE_MIN_AVERAGE_AMOUNT,
  DEFAULT_LEGITIMATE_MIN_TOTAL_VOLUME,
  DEFAULT_LEGITIMATE_MAX_ASSET_DIVERSITY,
  createDustingRule,
} from "./dusting.js";
export type { DustingRuleOptions } from "./dusting.js";

export {
  DEFAULT_CREATE_ACCOUNT_FUNDING_RULE_WEIGHT,
  DEFAULT_CREATE_ACCOUNT_FUNDING_MIN_SCORE,
  DEFAULT_CREATE_ACCOUNT_FUNDING_BURST_THRESHOLD,
  DEFAULT_CREATE_ACCOUNT_FUNDING_EXTREME_COUNT,
  createCreateAccountFundingRule,
} from "./createAccountFunding.js";
export type { CreateAccountFundingRuleOptions } from "./createAccountFunding.js";
