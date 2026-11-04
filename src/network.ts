/**
 * Stellar network presets and validation (issue #17).
 *
 * Centralizes network-specific defaults (Horizon URLs) so the
 * FraudDetector config validation can resolve defaults and callers can
 * discover the supported networks without hard-coding URLs.
 */

import { ValidationError } from "./errors.js";

export type NetworkPreset = "testnet" | "mainnet";

export const SUPPORTED_NETWORKS: readonly NetworkPreset[] = ["testnet", "mainnet"] as const;

export interface NetworkPresetConfig {
  /** Human-readable network name. */
  readonly name: string;
  /** Default Horizon API endpoint for this network. */
  readonly horizonUrl: string;
  /** Whether this network supports Soroban/RPC. */
  readonly sorobanRpc?: string;
}

export const NETWORK_PRESETS: Record<NetworkPreset, NetworkPresetConfig> = {
  testnet: {
    name: "Testnet",
    horizonUrl: "https://horizon-testnet.stellar.org",
    sorobanRpc: "https://soroban-testnet.stellar.org",
  },
  mainnet: {
    name: "Mainnet",
    horizonUrl: "https://horizon.stellar.org",
    sorobanRpc: "https://soroban.stellar.org",
  },
};

/**
 * Returns the preset configuration for a given network.
 *
 * Accepts a plain string so runtime configuration (environment
 * variables, CLI flags) is validated instead of blindly indexed into the
 * preset map. Unknown names fail with an actionable message that lists
 * every accepted value (#17, #72).
 *
 * @param network - Network name ("testnet" or "mainnet").
 * @returns The preset configuration.
 * @throws {ValidationError} If the network is not supported.
 *
 * @example
 * getNetworkPreset("testnet").horizonUrl;
 * // "https://horizon-testnet.stellar.org"
 */
export function getNetworkPreset(network: string): NetworkPresetConfig {
  if (!isSupportedNetwork(network)) {
    throw new ValidationError(
      `Unsupported network "${network}". Supported networks: ${SUPPORTED_NETWORKS.join(
        ", "
      )}. Use "testnet" for development or "mainnet" for production, or pass a custom horizonUrl.`
    );
  }
  return NETWORK_PRESETS[network];
}

/**
 * Resolves the Horizon URL for a network, honoring an explicit override.
 *
 * A custom `horizonUrl` always wins over the preset, so teams can point
 * the SDK at a private Horizon instance without losing the rest of the
 * network defaults (#17).
 *
 * @param network - Network name ("testnet" or "mainnet").
 * @param horizonUrl - Optional custom Horizon URL.
 * @returns The custom URL when provided, otherwise the preset default.
 * @throws {ValidationError} If the network is not supported.
 */
export function resolveHorizonUrl(network: string, horizonUrl?: string): string {
  // Validate the network even when an override is supplied, so a typo
  // never goes unnoticed just because a custom URL was also provided.
  const preset = getNetworkPreset(network);
  const override = horizonUrl?.trim();
  if (override && override.length > 0) {
    return override;
  }
  return preset.horizonUrl;
}

/**
 * Type guard to check if a value is a supported network.
 *
 * @param network - Candidate network name, possibly from untrusted input.
 * @returns True when the value is one of {@link SUPPORTED_NETWORKS}.
 */
export function isSupportedNetwork(network: unknown): network is NetworkPreset {
  return (
    typeof network === "string" &&
    SUPPORTED_NETWORKS.includes(network as NetworkPreset)
  );
}