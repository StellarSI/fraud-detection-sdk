/**
 * Stellar network presets and validation.
 *
 * Centralizes network-specific defaults (Horizon URLs) so the
 * FraudDetector config validation can resolve defaults.
 */

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
 * @param network - Network name ("testnet" or "mainnet").
 * @returns The preset configuration.
 * @throws {Error} If the network is not supported.
 */
export function getNetworkPreset(network: NetworkPreset): NetworkPresetConfig {
  const preset = NETWORK_PRESETS[network];
  if (!preset) {
    throw new Error(`Unsupported network: ${network}`);
  }
  return preset;
}

/**
 * Type guard to check if a string is a supported network.
 */
export function isSupportedNetwork(network: string): network is NetworkPreset {
  return SUPPORTED_NETWORKS.includes(network as NetworkPreset);
}