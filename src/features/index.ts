/**
 * Feature extraction families (issues #19, #20, #21, #22, #23, #31, #32).
 *
 * Re-exports the shared provider contracts plus the velocity, graph,
 * asset, memo, lifecycle, and claimable-balance implementations so the
 * registry (#24) and SDK consumers can import them from one place.
 */

export type {
  FeatureContext,
  FeatureMap,
  FeatureProvider,
  FeatureValue,
} from "./types.js";

export {
  DEFAULT_VELOCITY_WINDOWS,
  extractVelocityFeatures,
  velocityFeaturesToFeatureMap,
  createVelocityFeatureProvider,
} from "./velocity.js";
export type {
  VelocityFeatures,
  VelocityOptions,
  VelocityWindow,
} from "./velocity.js";

export {
  CounterpartyGraph,
  DEFAULT_MAX_GRAPH_NODES,
  DEFAULT_MAX_GRAPH_EDGES,
  DEFAULT_MAX_CLUSTERING_DEGREE,
  buildCounterpartyGraph,
  extractGraphFeatures,
  graphFeaturesToFeatureMap,
  createGraphFeatureProvider,
} from "./graph.js";
export type {
  CounterpartyGraphOptions,
  GraphFeatureOptions,
  GraphFeatures,
} from "./graph.js";

export {
  DEFAULT_TRUSTLINE_CHURN_WINDOW_MS,
  NATIVE_ASSET_ID,
  canonicalAssetId,
  extractAssetFeatures,
  assetFeaturesToFeatureMap,
  createAssetFeatureProvider,
} from "./assets.js";
export type {
  AssetFeatures,
  AssetFeatureOptions,
} from "./assets.js";

export {
  DEFAULT_MAX_MEMO_LENGTH,
  MEMO_VARIANTS,
  sanitizeMemo,
  normalizeMemoType,
  isValidMemoValue,
  extractMemoFeatures,
  memoFeaturesToFeatureMap,
  createMemoFeatureProvider,
} from "./memo.js";
export type {
  MemoFeatures,
  MemoFeatureOptions,
  MemoEntry,
  MemoType,
} from "./memo.js";

export {
  DEFAULT_RAPID_MERGE_WINDOW_MS,
  extractLifecycleFeatures,
  lifecycleFeaturesToFeatureMap,
  createLifecycleFeatureProvider,
} from "./lifecycle.js";
export type {
  LifecycleFeatures,
  LifecycleOptions,
} from "./lifecycle.js";

export {
  DEFAULT_RAPID_PATH_PAYMENT_WINDOW_MS,
  DEFAULT_LONG_CHAIN_HOPS,
  PATH_PAYMENT_TYPES,
  extractPathPaymentLayeringFeatures,
  getPathHopCount,
  hasCircularPath,
  isPathPaymentTransaction,
  pathPaymentLayeringFeaturesToFeatureMap,
  createPathPaymentLayeringFeatureProvider,
} from "./pathPaymentLayering.js";
export type {
  PathPaymentLayeringFeatures,
  PathPaymentLayeringOptions,
  PathPaymentLayeringProviderOptions,
} from "./pathPaymentLayering.js";

export {
  DEFAULT_TRUSTLINE_BURST_WINDOW_MS,
  DEFAULT_EXTREME_TRUSTLINE_COUNT,
  DEFAULT_TRUSTLINE_BURST_THRESHOLD,
  DEFAULT_TRUSTLINE_DUST_RATIO_THRESHOLD,
  DEFAULT_TRUSTLINE_SPAM_ISSUER_COUNT,
  extractTrustlineAbuseFeatures,
  isChangeTrustTransaction,
  trustlineAbuseFeaturesToFeatureMap,
  createTrustlineAbuseFeatureProvider,
} from "./trustlineAbuse.js";
export type {
  TrustlineAbuseFeatures,
  TrustlineAbuseOptions,
  TrustlineAbuseProviderOptions,
} from "./trustlineAbuse.js";

export {
  DEFAULT_DUST_THRESHOLD,
  extractDustingFeatures,
  dustingFeaturesToFeatureMap,
  createDustingFeatureProvider,
} from "./dusting.js";
export type {
  DustingFeatures,
  DustingOptions,
  DustingProviderOptions,
} from "./dusting.js";

export {
  DEFAULT_CREATE_ACCOUNT_FUNDING_WINDOW_MS,
  DEFAULT_CREATE_ACCOUNT_FUNDING_BURST_WINDOW_MS,
  DEFAULT_CREATE_ACCOUNT_FUNDING_BURST_THRESHOLD,
  DEFAULT_CREATE_ACCOUNT_FUNDING_EXTREME_COUNT,
  extractCreateAccountFundingFeatures,
  createAccountFundingFeaturesToFeatureMap,
  createCreateAccountFundingFeatureProvider,
} from "./createAccountFunding.js";
export type {
  CreateAccountFundingFeatures,
  CreateAccountFundingOptions,
  CreateAccountFundingProviderOptions,
} from "./createAccountFunding.js";

export {
  DEFAULT_CLAIMABLE_BALANCE_WINDOW_MS,
  DEFAULT_CLAIMABLE_BALANCE_BURST_WINDOW_MS,
  DEFAULT_CLAIMABLE_BALANCE_BURST_THRESHOLD,
  DEFAULT_CLAIMABLE_BALANCE_EXTREME_COUNT,
  DEFAULT_CLAIMABLE_BALANCE_UNCLAIMED_AGE_MS,
  DEFAULT_CLAIMABLE_BALANCE_SPAM_RECIPIENT_THRESHOLD,
  CLAIMABLE_BALANCE_AIRDROP_MEMO_PATTERN,
  extractClaimableBalanceFeatures,
  claimableBalanceFeaturesToFeatureMap,
  createClaimableBalanceFeatureProvider,
} from "./claimableBalances.js";
export type {
  ClaimableBalanceFeatures,
  ClaimableBalanceOptions,
  ClaimableBalanceProviderOptions,
} from "./claimableBalances.js";

export {
  FeatureRegistry,
  createFeatureRegistry,
  createDefaultFeatureRegistry,
  createDefaultFeatureProviders,
  extractFeatures,
} from "./registry.js";
export type { FeatureRegistryOptions } from "./registry.js";
