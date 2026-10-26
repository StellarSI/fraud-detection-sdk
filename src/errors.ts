/**
 * Shared error taxonomy for @stellarsi/fraud-detection-sdk (issue #9).
 *
 * Every failure that crosses the SDK's public surface is expressed as a
 * member of this taxonomy, so consumers can catch SDK errors without
 * knowing whether the failure originated on Horizon, another upstream
 * API, or inside the SDK itself.
 *
 * Rules for this file:
 * - Every subclass has a distinct, stable machine-readable `code`.
 * - The original failure is preserved on `cause` for debugging; messages
 *   stay clear and jargon-free so they can be shown to end users.
 * - `HorizonError`, `DetectorConfigError`, and the detailed
 *   `ConfigError` (with reason codes such as INVALID_NETWORK) are
 *   declared next to the code that raises them (FraudDetector.ts and
 *   config.ts); they extend the same base, so a single `catch` on
 *   `FraudDetectorError` covers the whole taxonomy.
 */

/** Options shared by all concrete taxonomy constructors. */
export interface FraudDetectorErrorOptions {
  /** The underlying error that triggered this one (for debugging). */
  cause?: unknown;
  /** Whether the caller can reasonably retry the failed operation. */
  recoverable?: boolean;
}

/**
 * Base class for all errors thrown by the fraud detection SDK.
 *
 * Carries a stable machine-readable `code`, a human-friendly `message`,
 * and optionally chains the underlying failure on `cause`.
 */
export class FraudDetectorError extends Error {
  /**
   * Stable, machine-readable error code (e.g. "VALIDATION_ERROR").
   * Writable so specialized error families (config.ConfigError) can
   * refine the generic class code with a more precise reason code.
   */
  code: string;
  /** Whether the failed operation can reasonably be retried. */
  readonly recoverable: boolean;

  constructor(
    message: string,
    code: string,
    options: FraudDetectorErrorOptions = {}
  ) {
    super(message, { cause: options.cause });
    this.name = "FraudDetectorError";
    this.code = code;
    this.recoverable = options.recoverable ?? false;
  }
}

/**
 * The SDK (or a caller) was misconfigured.
 *
 * Raised when options fail validation before any network activity.
 * Specifically-typed reasons (INVALID_NETWORK, INVALID_HORIZON_URL,
 * ...) live on config.ConfigError, which extends this class.
 */
export class ConfigError extends FraudDetectorError {
  constructor(message: string, options: FraudDetectorErrorOptions = {}) {
    super(message, "CONFIG_ERROR", options);
    this.name = "ConfigError";
  }
}

/** A caller-supplied value failed validation (bad address, thresholds, ...). */
export class ValidationError extends FraudDetectorError {
  constructor(message: string, options: FraudDetectorErrorOptions = {}) {
    super(message, "VALIDATION_ERROR", options);
    this.name = "ValidationError";
  }
}

/**
 * The requested resource does not exist (e.g. an unknown account ID).
 * Not retriable as-is, but often indicates a call for the wrong network.
 */
export class NotFoundError extends FraudDetectorError {
  /** Identifier of the missing resource, when known (e.g. an account ID). */
  readonly resourceId?: string;

  constructor(
    message: string,
    options: FraudDetectorErrorOptions & { resourceId?: string } = {}
  ) {
    super(message, "NOT_FOUND", options);
    this.name = "NotFoundError";
    if (options.resourceId !== undefined) {
      this.resourceId = options.resourceId;
    }
  }
}

/**
 * The upstream service asked us to slow down (HTTP 429).
 * Retriable, ideally after `retryAfterMs`.
 */
export class RateLimitError extends FraudDetectorError {
  /** Recommended wait before retrying, in milliseconds, when provided. */
  readonly retryAfterMs?: number;

  constructor(
    message: string,
    options: FraudDetectorErrorOptions & { retryAfterMs?: number } = {}
  ) {
    super(message, "RATE_LIMIT", { ...options, recoverable: options.recoverable ?? true });
    this.name = "RateLimitError";
    if (options.retryAfterMs !== undefined) {
      this.retryAfterMs = options.retryAfterMs;
    }
  }
}

/**
 * The upstream service responded with an unexpected failure (HTTP 4xx
 * other than 404/429, or any 5xx). Retriable for 5xx responses.
 */
export class UpstreamError extends FraudDetectorError {
  /** HTTP status returned by the upstream service, when known. */
  readonly upstreamStatus?: number;

  constructor(
    message: string,
    options: FraudDetectorErrorOptions & { upstreamStatus?: number } = {}
  ) {
    super(message, "UPSTREAM_ERROR", options);
    this.name = "UpstreamError";
    if (options.upstreamStatus !== undefined) {
      this.upstreamStatus = options.upstreamStatus;
    }
  }
}

/**
 * The upstream service could not be reached at all (connection refused,
 * DNS failure, offline, ...). Usually retriable once connectivity returns.
 */
export class NetworkError extends FraudDetectorError {
  constructor(message: string, options: FraudDetectorErrorOptions = {}) {
    super(message, "NETWORK_ERROR", { ...options, recoverable: options.recoverable ?? true });
    this.name = "NetworkError";
  }
}

/** Stable codes for every taxonomy member, exported for programmatic checks. */
export const ERROR_CODES = {
  config: "CONFIG_ERROR",
  validation: "VALIDATION_ERROR",
  notFound: "NOT_FOUND",
  rateLimit: "RATE_LIMIT",
  upstream: "UPSTREAM_ERROR",
  network: "NETWORK_ERROR",
} as const;

/** Narrowing helper for the whole taxonomy (`instanceof` equivalent). */
export function isFraudDetectorError(error: unknown): error is FraudDetectorError {
  return error instanceof FraudDetectorError;
}
