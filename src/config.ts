/**
 * Configuration types and validation for FraudDetector.
 *
 * Validates constructor options and provides clear error messages
 * for misconfiguration (matches README.md quick-start).
 */

import { NetworkPreset, NETWORK_PRESETS, SUPPORTED_NETWORKS } from "./network.js";
import { ThresholdConfig, DEFAULT_THRESHOLDS, validateThresholds } from "./scoring/levels.js";

/**
 * Error thrown when FraudDetector configuration is invalid.
 *
 * Extends Error with a `code` property for programmatic handling.
 */
export class ConfigError extends Error {
  public readonly code: "INVALID_NETWORK" | "MISSING_REQUIRED" | "INVALID_HORIZON_URL" | "INVALID_CONFIG";

  constructor(message: string, code: ConfigError["code"]) {
    super(message);
    this.name = "ConfigError";
    this.code = code;
  }
}

/**
 * User-facing configuration options for FraudDetector.
 *
 * Matches the quick-start example in README.md:
 * ```ts
 * new FraudDetector({ network: "testnet", horizonUrl: "https://..." })
 * ```
 */
export interface FraudDetectorOptions {
  /** Network to operate on: "testnet" or "mainnet". */
  network: NetworkPreset;
  /**
   * Optional Horizon endpoint URL.
   * If omitted, the network preset's default Horizon URL is used.
   */
  horizonUrl?: string;
  /**
   * Optional pre-configured Horizon client for dependency injection.
   * If provided, `horizonUrl` is ignored.
   * Useful for tests and custom retry/auth logic.
   */
  horizonClient?: HorizonClientLike;
  /**
   * Optional risk classification thresholds.
   * If omitted, defaults from README.md:74-78 are used (low=0.40, high=0.70).
   * Must satisfy 0 <= low < high <= 1.
   */
  thresholds?: {
    /** Score below this is classified as "low". Default: 0.40 */
    low: number;
    /** Score above this is classified as "high". Default: 0.70 */
    high: number;
  };
}

/**
 * Minimal interface for a Horizon client.
 * Allows dependency injection of a real or mock client.
 */
export interface HorizonClientLike {
  getAccount(accountId: string): Promise<unknown>;
  getAccountTransactions(accountId: string): Promise<unknown[]> | AsyncIterable<unknown>;
}

/**
 * Re-export for convenience
 */
export { SUPPORTED_NETWORKS };

/**
 * Resolves and validates the FraudDetector configuration.
 *
 * @param options - Raw options passed to the constructor.
 * @returns Validated configuration with resolved defaults.
 * @throws {ConfigError} If validation fails.
 */
export function resolveConfig(options: Partial<FraudDetectorOptions>): FraudDetectorOptions {
  if (!options || typeof options !== "object") {
    throw new ConfigError("Configuration object is required", "MISSING_REQUIRED");
  }

  // Validate network
  const network = options.network;
  if (!network) {
    throw new ConfigError(
      "Network is required. Must be one of: " + SUPPORTED_NETWORKS.join(", "),
      "MISSING_REQUIRED"
    );
  }

  if (!SUPPORTED_NETWORKS.includes(network)) {
    throw new ConfigError(
      `Unknown network "${network}". Supported networks: ${SUPPORTED_NETWORKS.join(", ")}`,
      "INVALID_NETWORK"
    );
  }

  // Validate thresholds if provided
  let thresholds: { low: number; high: number } | undefined;
  if (options.thresholds !== undefined) {
    const { low, high } = options.thresholds;
    if (typeof low !== "number" || typeof high !== "number") {
      throw new ConfigError(
        "Thresholds must be numbers",
        "INVALID_CONFIG"
      );
    }
    if (!Number.isFinite(low) || !Number.isFinite(high)) {
      throw new ConfigError(
        "Thresholds must be finite numbers",
        "INVALID_CONFIG"
      );
    }
    if (low < 0 || low > 1) {
      throw new ConfigError(
        `Low threshold must be in [0, 1], got ${low}`,
        "INVALID_CONFIG"
      );
    }
    if (high < 0 || high > 1) {
      throw new ConfigError(
        `High threshold must be in [0, 1], got ${high}`,
        "INVALID_CONFIG"
      );
    }
    if (low >= high) {
      throw new ConfigError(
        `Low threshold (${low}) must be strictly less than high threshold (${high})`,
        "INVALID_CONFIG"
      );
    }
    thresholds = { low, high };
  }

  // Resolve horizonUrl from preset if not provided
  let horizonUrl = options.horizonUrl;
  if (!horizonUrl) {
    horizonUrl = NETWORK_PRESETS[network].horizonUrl;
  } else {
    // Validate URL format
    try {
      new URL(horizonUrl);
    } catch {
      throw new ConfigError(
        `Invalid horizonUrl: "${horizonUrl}". Must be a valid HTTP/HTTPS URL.`,
        "INVALID_HORIZON_URL"
      );
    }
    if (!horizonUrl.startsWith("http://") && !horizonUrl.startsWith("https://")) {
      throw new ConfigError(
        `Invalid horizonUrl: "${horizonUrl}". Must use http:// or https://.`,
        "INVALID_HORIZON_URL"
      );
    }
  }

  return {
    network,
    horizonUrl,
    horizonClient: options.horizonClient,
    thresholds,
  };
}

/**
 * Type guard to check if an error is a ConfigError.
 */
export function isConfigError(error: unknown): error is ConfigError {
  return error instanceof ConfigError;
}