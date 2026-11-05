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