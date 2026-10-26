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
export { NetworkPreset, NETWORK_PRESETS, getNetworkPreset, isSupportedNetwork } from "./network.js";
export { normalizeScore, normalizeScoreWithRange, clipToUnitInterval, roundToPrecision, DEFAULT_SCORE_PRECISION } from "./scoring/normalize.js";
export { classifyLevel, classify, getSuggestedAction, validateThresholds, DEFAULT_THRESHOLDS } from "./scoring/levels.js";
export { ScoreResult, Signal, RiskLevel, AccountRisk } from "./types.js";