/**
 * Public entry point for @stellarsi/fraud-detection-sdk.
 *
 * The FraudDetector class, config utilities, and public types.
 */

export { FraudDetector, DefaultHorizonClient, HorizonClient } from "./FraudDetector.js";
export { FraudDetectorError, ValidationError, HorizonError, DetectorConfigError } from "./FraudDetector.js";
export { FraudDetectorOptions, ConfigError as ConfigErrorClass, resolveConfig, isConfigError, SUPPORTED_NETWORKS } from "./config.js";
export {
  // Shared error taxonomy (issue #9): ConfigError here is the generic
  // taxonomy member; ConfigErrorClass above is the config-module class
  // with detailed reason codes, and both share the same base.
  ConfigError,
  NotFoundError,
  RateLimitError,
  UpstreamError,
  NetworkError,
  isFraudDetectorError,
  ERROR_CODES,
} from "./errors.js";
export {
  NetworkPreset,
  NETWORK_PRESETS,
  getNetworkPreset,
  isSupportedNetwork,
  resolveHorizonUrl,
} from "./network.js";
export { normalizeScore, normalizeScoreWithRange, clipToUnitInterval, roundToPrecision, DEFAULT_SCORE_PRECISION } from "./scoring/normalize.js";
export { classifyLevel, classify, getSuggestedAction, validateThresholds, DEFAULT_THRESHOLDS } from "./scoring/levels.js";
export { aggregate, compareSignals } from "./scoring/aggregate.js";
export {
  createLogger,
  setLogger,
  getLogger,
  resetLogger,
  redact,
  asSink,
  DEFAULT_LOG_LEVEL,
} from "./logging.js";
export type {
  Logger,
  LoggerOptions,
  LogSink,
  HostLogger,
  LogContext,
  LogLevel,
} from "./logging.js";
export type { AggregateOptions } from "./scoring/aggregate.js";
export { ScoreResult, Signal, RiskLevel, AccountRisk } from "./types.js";
export {
  HorizonRestClient,
  createHorizonRestClient,
  validateAccountId,
  normalizeAccount,
  normalizeTransaction,
  normalizeSetOptions,
  paginate,
  collect,
  DEFAULT_PAGINATION_LIMIT,
} from "./clients/horizon.js";
export {
  withRetry,
  fetchWithRetry,
  type RetryOptions,
} from "./clients/http.js";
export {
  HTTP_STATUS_ERROR_RULES,
  extractUpstreamDetail,
  mapHttpResponseToError,
  parseRetryAfterMs,
  resolveHttpStatusRule,
} from "./clients/errorMapping.js";
export type {
  HttpErrorKind,
  HttpStatusRule,
  MapHttpErrorOptions,
} from "./clients/errorMapping.js";
export type { UpstreamErrorDetail } from "./errors.js";
export {
  TransactionAnalyticsClient,
  createTransactionAnalyticsClient,
  normalizeTransactionAnalyticsAccount,
  normalizeTransactionAnalyticsFlow,
  validateAccountId as validateTransactionAnalyticsAccountId,
} from "./clients/transactionAnalytics.js";
export type {
  Account,
  AccountBalance,
  AccountSigner,
  SetOptionsDetails,
  SetOptionsSigner,
  SetOptionsThresholds,
  Transaction,
  GetTransactionsOptions,
  Page,
  FetchPage,
  PaginateOptions,
  HorizonRestClientOptions,
} from "./clients/horizon.js";
export type { DataSource } from "./clients/transactionAnalytics.js";
export {
  DEFAULT_VELOCITY_WINDOWS,
  extractVelocityFeatures,
  velocityFeaturesToFeatureMap,
  createVelocityFeatureProvider,
} from "./features/velocity.js";
export type {
  VelocityFeatures,
  VelocityOptions,
  VelocityWindow,
} from "./features/velocity.js";
export type {
  FeatureContext,
  FeatureMap,
  FeatureProvider,
  FeatureValue,
} from "./features/types.js";
export {
  CounterpartyGraph,
  DEFAULT_MAX_GRAPH_NODES,
  DEFAULT_MAX_GRAPH_EDGES,
  DEFAULT_MAX_CLUSTERING_DEGREE,
  buildCounterpartyGraph,
  extractGraphFeatures,
  graphFeaturesToFeatureMap,
  createGraphFeatureProvider,
} from "./features/graph.js";
export type {
  CounterpartyGraphOptions,
  GraphFeatureOptions,
  GraphFeatures,
} from "./features/graph.js";
export {
  DEFAULT_TRUSTLINE_CHURN_WINDOW_MS,
  NATIVE_ASSET_ID,
  canonicalAssetId,
  extractAssetFeatures,
  assetFeaturesToFeatureMap,
  createAssetFeatureProvider,
} from "./features/assets.js";
export type {
  AssetFeatures,
  AssetFeatureOptions,
} from "./features/assets.js";
export {
  DEFAULT_MAX_MEMO_LENGTH,
  MEMO_VARIANTS,
  sanitizeMemo,
  normalizeMemoType,
  isValidMemoValue,
  extractMemoFeatures,
  memoFeaturesToFeatureMap,
  createMemoFeatureProvider,
} from "./features/memo.js";
export type {
  MemoFeatures,
  MemoFeatureOptions,
  MemoEntry,
  MemoType,
} from "./features/memo.js";
export {
  DEFAULT_RAPID_MERGE_WINDOW_MS,
  extractLifecycleFeatures,
  lifecycleFeaturesToFeatureMap,
  createLifecycleFeatureProvider,
} from "./features/lifecycle.js";
export type {
  LifecycleFeatures,
  LifecycleOptions,
} from "./features/lifecycle.js";
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
} from "./features/pathPaymentLayering.js";
export type {
  PathPaymentLayeringFeatures,
  PathPaymentLayeringOptions,
  PathPaymentLayeringProviderOptions,
} from "./features/pathPaymentLayering.js";
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
} from "./features/trustlineAbuse.js";
export type {
  TrustlineAbuseFeatures,
  TrustlineAbuseOptions,
  TrustlineAbuseProviderOptions,
} from "./features/trustlineAbuse.js";
export {
  DEFAULT_DUST_THRESHOLD,
  extractDustingFeatures,
  dustingFeaturesToFeatureMap,
  createDustingFeatureProvider,
} from "./features/dusting.js";
export type {
  DustingFeatures,
  DustingOptions,
  DustingProviderOptions,
} from "./features/dusting.js";
export {
  DEFAULT_CREATE_ACCOUNT_FUNDING_WINDOW_MS,
  DEFAULT_CREATE_ACCOUNT_FUNDING_BURST_WINDOW_MS,
  DEFAULT_CREATE_ACCOUNT_FUNDING_BURST_THRESHOLD,
  DEFAULT_CREATE_ACCOUNT_FUNDING_EXTREME_COUNT,
  extractCreateAccountFundingFeatures,
  createAccountFundingFeaturesToFeatureMap,
  createCreateAccountFundingFeatureProvider,
} from "./features/createAccountFunding.js";
export type {
  CreateAccountFundingFeatures,
  CreateAccountFundingOptions,
  CreateAccountFundingProviderOptions,
} from "./features/createAccountFunding.js";
export {
  DEFAULT_ANCHOR_OUTLIER_Z_SCORE,
  canonicalTransactionAssetId,
  extractAnchorAnomalyFeatures,
  anchorAnomalyFeaturesToFeatureMap,
  createAnchorAnomalyFeatureProvider,
} from "./features/anchorAnomaly.js";
export type {
  AnchorAnomalyFeatures,
  AnchorAnomalyOptions,
  AnchorAnomalyProviderOptions,
} from "./features/anchorAnomaly.js";
export {
  SET_OPTIONS_TYPES,
  AUTH_FLAGS,
  CLAWBACK_ENABLED_FLAG,
  extractMultisigAuthFeatures,
  multisigAuthFeaturesToFeatureMap,
  createMultisigAuthFeatureProvider,
} from "./features/multisigAuth.js";
export type {
  MultisigAuthFeatures,
  MultisigAuthOptions,
  MultisigAuthProviderOptions,
} from "./features/multisigAuth.js";
export {
  DEFAULT_CLAWBACK_ACTIVITY_WINDOW_MS,
  DEFAULT_CLAWBACK_ACTIVITY_BURST_WINDOW_MS,
  DEFAULT_CLAWBACK_ACTIVITY_BURST_THRESHOLD,
  CLAWBACK_OPERATION_TYPES,
  isClawbackOperation,
  extractClawbackActivityFeatures,
  clawbackActivityFeaturesToFeatureMap,
  createClawbackActivityFeatureProvider,
} from "./features/clawbackActivity.js";
export type {
  ClawbackActivityFeatures,
  ClawbackActivityOptions,
  ClawbackActivityProviderOptions,
} from "./features/clawbackActivity.js";
export {
  DEFAULT_FAN_WINDOW_LEDGERS,
  DEFAULT_FAN_BURST_LEDGERS,
  extractFanInOutFeatures,
  fanInOutFeaturesToFeatureMap,
  createFanInOutFeatureProvider,
} from "./features/fanInOut.js";
export type {
  FanInOutFeatures,
  FanInOutOptions,
  FanInOutProviderOptions,
} from "./features/fanInOut.js";
export {
  DEFAULT_GRAPH_MAX_EDGES,
  DEFAULT_GRAPH_MAX_NODES,
  Graph,
} from "./graph/graph.js";
export type {
  GraphEdge,
  GraphMetadataValue,
  GraphNode,
  GraphOptions,
  GraphTraversalOptions,
  GraphView,
  GraphVisit,
} from "./graph/types.js";
export {
  ConnectedComponentsClustering,
  LabelPropagationClustering,
  DEFAULT_MAX_LABEL_ITERATIONS,
  DEFAULT_MIN_CLUSTER_DENSITY,
  DEFAULT_MIN_CLUSTER_SIZE,
  clusterForAccount,
  clusteringFeaturesToFeatureMap,
  computeClusters,
  createClusteringFeatureProvider,
  extractClusteringFeatures,
} from "./graph/clustering.js";
export type {
  ClusteringAlgorithm,
  ClusteringFeatures,
  ClusteringOptions,
  CounterpartyCluster,
} from "./graph/clustering.js";
export {
  FeatureRegistry,
  createFeatureRegistry,
  createDefaultFeatureRegistry,
  createDefaultFeatureProviders,
  extractFeatures,
} from "./features/registry.js";
export type { FeatureRegistryOptions } from "./features/registry.js";
export {
  RuleEngine,
  createRuleEngine,
  createDefaultRuleEngine,
  createRule,
  createFreshAccountRule,
  createRapidFanOutRule,
  createHighVelocityRule,
  createDefaultRules,
} from "./rules/engine.js";
export type { Rule, RuleContext, RuleEngineOptions } from "./rules/engine.js";
export {
  RuleRegistry,
  createRuleRegistry,
  createDefaultRuleRegistry,
} from "./rules/registry.js";
export type { RuleRegistryEntry, RuleRegistrySnapshot } from "./rules/registry.js";
export { createPathPaymentLayeringRule } from "./rules/pathPaymentLayering.js";
export type { PathPaymentLayeringRuleOptions } from "./rules/pathPaymentLayering.js";
export {
  DEFAULT_TRUSTLINE_ABUSE_RULE_WEIGHT,
  DEFAULT_TRUSTLINE_ABUSE_MIN_SCORE,
  DEFAULT_TRUSTLINE_ABUSE_EXTREME_COUNT,
  DEFAULT_TRUSTLINE_ABUSE_BURST_THRESHOLD,
  DEFAULT_TRUSTLINE_ABUSE_DUST_RATIO,
  DEFAULT_TRUSTLINE_ABUSE_SPAM_ISSUERS,
  createTrustlineAbuseRule,
} from "./rules/trustlineAbuse.js";
export type { TrustlineAbuseRuleOptions } from "./rules/trustlineAbuse.js";
export {
  DEFAULT_THROWAWAY_MERGE_RULE_WEIGHT,
  DEFAULT_YOUNG_ACCOUNT_MAX_AGE_MS,
  DEFAULT_MAX_MS_TO_FIRST_MERGE,
  DEFAULT_MIN_MERGE_COUNT,
  DEFAULT_THROWAWAY_MERGE_MIN_SCORE,
  createThrowawayMergeRule,
} from "./rules/throwawayMerge.js";
export type { ThrowawayMergeRuleOptions } from "./rules/throwawayMerge.js";
export {
  DEFAULT_DUSTING_RULE_WEIGHT,
  DEFAULT_DUSTING_RECIPIENT_THRESHOLD,
  DEFAULT_DUSTING_PAYMENT_THRESHOLD,
  DEFAULT_DUSTING_MIN_SCORE,
  DEFAULT_LEGITIMATE_MIN_AVERAGE_AMOUNT,
  DEFAULT_LEGITIMATE_MIN_TOTAL_VOLUME,
  DEFAULT_LEGITIMATE_MAX_ASSET_DIVERSITY,
  createDustingRule,
} from "./rules/dusting.js";
export type { DustingRuleOptions } from "./rules/dusting.js";
export {
  DEFAULT_CREATE_ACCOUNT_FUNDING_RULE_WEIGHT,
  DEFAULT_CREATE_ACCOUNT_FUNDING_MIN_SCORE,
  createCreateAccountFundingRule,
} from "./rules/createAccountFunding.js";
export type { CreateAccountFundingRuleOptions } from "./rules/createAccountFunding.js";
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
} from "./features/claimableBalances.js";
export type {
  ClaimableBalanceFeatures,
  ClaimableBalanceOptions,
  ClaimableBalanceProviderOptions,
} from "./features/claimableBalances.js";
export {
  DEFAULT_CLAIMABLE_BALANCE_ABUSE_RULE_WEIGHT,
  DEFAULT_CLAIMABLE_BALANCE_ABUSE_MIN_SCORE,
  DEFAULT_CLAIMABLE_BALANCE_ABUSE_EXTREME_COUNT,
  DEFAULT_CLAIMABLE_BALANCE_ABUSE_BURST_THRESHOLD,
  DEFAULT_CLAIMABLE_BALANCE_ABUSE_UNCLAIMED_RATIO,
  createClaimableBalanceAbuseRule,
} from "./rules/claimableBalanceAbuse.js";
export type { ClaimableBalanceAbuseRuleOptions } from "./rules/claimableBalanceAbuse.js";
export {
  DEFAULT_UNSOLICITED_CLAIM_SPAM_RULE_WEIGHT,
  DEFAULT_UNSOLICITED_CLAIM_SPAM_MIN_SCORE,
  DEFAULT_UNSOLICITED_CLAIM_SPAM_RECIPIENT_THRESHOLD,
  DEFAULT_UNSOLICITED_CLAIM_SPAM_UNRELATED_RATIO,
  DEFAULT_UNSOLICITED_CLAIM_SPAM_AIRDROP_MAX_ASSET_DIVERSITY,
  createUnsolicitedClaimSpamRule,
} from "./rules/unsolicitedClaimSpam.js";
export type { UnsolicitedClaimSpamRuleOptions } from "./rules/unsolicitedClaimSpam.js";
export {
  DEFAULT_ANCHOR_ANOMALY_RULE_WEIGHT,
  DEFAULT_ANCHOR_ANOMALY_MIN_SCORE,
  DEFAULT_ANCHOR_ANOMALY_MIN_TRANSACTIONS,
  DEFAULT_ANCHOR_ANOMALY_MISSING_MEMO_RATIO,
  DEFAULT_ANCHOR_ANOMALY_MEMO_REUSE_THRESHOLD,
  DEFAULT_ANCHOR_ANOMALY_CONCENTRATION_THRESHOLD,
  DEFAULT_ANCHOR_ANOMALY_OUTLIER_THRESHOLD,
  createAnchorAnomalyRule,
} from "./rules/anchorAnomaly.js";
export type { AnchorAnomalyRuleOptions } from "./rules/anchorAnomaly.js";
export {
  DEFAULT_MULTISIG_AUTHORIZATION_RULE_WEIGHT,
  DEFAULT_MULTISIG_AUTHORIZATION_MIN_SCORE,
  createMultisigAuthorizationRule,
} from "./rules/multisigAuth.js";
export type { MultisigAuthorizationRuleOptions } from "./rules/multisigAuth.js";
export {
  DEFAULT_REUSED_MEMO_ID_RULE_WEIGHT,
  DEFAULT_REUSED_MEMO_ID_MIN_SCORE,
  DEFAULT_REUSED_MEMO_ID_REUSE_THRESHOLD,
  DEFAULT_REUSED_MEMO_ID_DISTINCT_THRESHOLD,
  createReusedMemoIdRule,
} from "./rules/reusedMemoId.js";
export type { ReusedMemoIdRuleOptions } from "./rules/reusedMemoId.js";
export {
  DEFAULT_CLAWBACK_ACTIVITY_RULE_WEIGHT,
  DEFAULT_CLAWBACK_ACTIVITY_MIN_SCORE,
  DEFAULT_CLAWBACK_ACTIVITY_OPERATION_THRESHOLD,
  DEFAULT_CLAWBACK_ACTIVITY_VOLUME_THRESHOLD,
  DEFAULT_CLAWBACK_ACTIVITY_FREQUENCY_THRESHOLD,
  DEFAULT_CLAWBACK_ACTIVITY_RULE_BURST_THRESHOLD,
  createClawbackActivityRule,
} from "./rules/clawbackActivity.js";
export type { ClawbackActivityRuleOptions } from "./rules/clawbackActivity.js";
export {
  DEFAULT_FAN_IN_OUT_RULE_WEIGHT,
  DEFAULT_FAN_IN_OUT_MIN_SCORE,
  DEFAULT_FAN_IN_OUT_DEGREE_THRESHOLD,
  DEFAULT_FAN_IN_OUT_BURST_THRESHOLD,
  DEFAULT_FAN_IN_OUT_SPEED_THRESHOLD,
  createFanInOutRule,
} from "./rules/fanInOut.js";
export type { FanInOutRuleOptions } from "./rules/fanInOut.js";
export {
  DEFAULT_COUNTERPARTY_CLUSTER_RULE_WEIGHT,
  DEFAULT_COUNTERPARTY_CLUSTER_MIN_SCORE,
  DEFAULT_COUNTERPARTY_CLUSTER_MIN_SIZE,
  DEFAULT_COUNTERPARTY_CLUSTER_MIN_DENSITY,
  createCounterpartyClusterRule,
} from "./rules/counterpartyCluster.js";
export type { CounterpartyClusterRuleOptions } from "./rules/counterpartyCluster.js";
export {
  DEFAULT_BASELINE_RULE_WEIGHT,
  DEFAULT_BASELINE_MIN_OBSERVATIONS,
  DEFAULT_BASELINE_DEVIATION_THRESHOLD,
  DEFAULT_BASELINE_MAX_AGE_MS,
  BaselineAccount,
  InMemoryBaselineStore,
  createBaselineRule,
} from "./models/baselineAccount.js";
export type {
  BaselineSnapshot,
  BaselineStore,
  BaselineAccountOptions,
  BaselineRuleOptions,
} from "./models/baselineAccount.js";

// Unified, async model plugin contract (issue #43).
export { isModelPlugin } from "./models/types.js";
export type {
  ModelContext,
  ModelPlugin,
  ModelPluginOptions,
} from "./models/types.js";
export {
  createRulesModelPlugin,
  createStatisticalModelPlugin,
  createMLModelPlugin,
  createModelPluginRegistry,
  ModelPluginRegistry,
} from "./models/plugins.js";
export type {
  RulesModelPluginOptions,
  StatisticalModelPluginOptions,
  MLModelPluginOptions,
  MLPredict,
} from "./models/plugins.js";
export {
  StatisticalAnomalyDetector,
  createStatisticalAnomalyDetector,
} from "./models/statistical.js";
export type {
  StatisticalDetectorOptions,
  StatisticalDetectionResult,
} from "./models/statistical.js";
