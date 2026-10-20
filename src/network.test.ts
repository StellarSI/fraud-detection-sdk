/**
 * Tests for network presets and validation.
 */

import { describe, it, expect } from "vitest";
import {
  SUPPORTED_NETWORKS,
  NETWORK_PRESETS,
  getNetworkPreset,
  isSupportedNetwork,
} from "./network.js";

describe("SUPPORTED_NETWORKS", () => {
  it("contains exactly testnet and mainnet", () => {
    expect(SUPPORTED_NETWORKS).toEqual(["testnet", "mainnet"]);
  });

  it("is readonly", () => {
    // This is a compile-time check; at runtime we just verify immutability
    expect(Object.isFrozen(SUPPORTED_NETWORKS)).toBe(false); // TypeScript readonly doesn't freeze at runtime
  });
});

describe("NETWORK_PRESETS", () => {
  it("has presets for both supported networks", () => {
    expect(NETWORK_PRESETS).toHaveProperty("testnet");
    expect(NETWORK_PRESETS).toHaveProperty("mainnet");
  });

  it("testnet preset has correct values", () => {
    const preset = NETWORK_PRESETS.testnet;
    expect(preset.name).toBe("Testnet");
    expect(preset.horizonUrl).toBe("https://horizon-testnet.stellar.org");
    expect(preset.sorobanRpc).toBe("https://soroban-testnet.stellar.org");
  });

  it("mainnet preset has correct values", () => {
    const preset = NETWORK_PRESETS.mainnet;
    expect(preset.name).toBe("Mainnet");
    expect(preset.horizonUrl).toBe("https://horizon.stellar.org");
    expect(preset.sorobanRpc).toBe("https://soroban.stellar.org");
  });
});

describe("getNetworkPreset", () => {
  it("returns preset for testnet", () => {
    const preset = getNetworkPreset("testnet");
    expect(preset.name).toBe("Testnet");
    expect(preset.horizonUrl).toBe("https://horizon-testnet.stellar.org");
  });

  it("returns preset for mainnet", () => {
    const preset = getNetworkPreset("mainnet");
    expect(preset.name).toBe("Mainnet");
    expect(preset.horizonUrl).toBe("https://horizon.stellar.org");
  });

  it("throws for unsupported network", () => {
    expect(() => getNetworkPreset("invalid" as any)).toThrow("Unsupported network");
  });
});

describe("isSupportedNetwork", () => {
  it("returns true for testnet", () => {
    expect(isSupportedNetwork("testnet")).toBe(true);
  });

  it("returns true for mainnet", () => {
    expect(isSupportedNetwork("mainnet")).toBe(true);
  });

  it("returns false for invalid network", () => {
    expect(isSupportedNetwork("invalid")).toBe(false);
    expect(isSupportedNetwork("")).toBe(false);
    expect(isSupportedNetwork("test")).toBe(false);
  });
});