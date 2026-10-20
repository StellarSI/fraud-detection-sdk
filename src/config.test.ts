/**
 * Tests for FraudDetector configuration validation.
 *
 * Covers valid config, invalid network, missing required fields,
 * horizon URL validation, and injected client handling.
 */

import { describe, it, expect } from "vitest";
import { resolveConfig, ConfigError, isConfigError, SUPPORTED_NETWORKS } from "./config.js";
import { NetworkPreset } from "./network.js";

describe("resolveConfig", () => {
  it("accepts valid config with network and optional horizonUrl", () => {
    const cfg = resolveConfig({ network: "testnet" });
    expect(cfg.network).toBe("testnet");
    expect(cfg.horizonUrl).toBe("https://horizon-testnet.stellar.org");
  });

  it("accepts valid config with custom horizonUrl", () => {
    const cfg = resolveConfig({
      network: "mainnet",
      horizonUrl: "https://custom-horizon.example.com",
    });
    expect(cfg.network).toBe("mainnet");
    expect(cfg.horizonUrl).toBe("https://custom-horizon.example.com");
  });

  it("accepts injected horizonClient and ignores horizonUrl", () => {
    const mockClient = {
      getAccount: async () => {},
      getAccountTransactions: async () => [],
    };
    const cfg = resolveConfig({
      network: "testnet",
      horizonUrl: "https://ignored.example.com",
      horizonClient: mockClient,
    });
    expect(cfg.horizonClient).toBe(mockClient);
    expect(cfg.horizonUrl).toBe("https://horizon-testnet.stellar.org");
  });

  it("throws ConfigError for missing network", () => {
    expect(() => resolveConfig({})).toThrow(ConfigError);
    expect(() => resolveConfig({})).toThrow("Network is required");
  });

  it("throws ConfigError for invalid network", () => {
    expect(() => resolveConfig({ network: "invalid" as NetworkPreset })).toThrow(ConfigError);
    expect(() => resolveConfig({ network: "invalid" as NetworkPreset })).toThrow("Unknown network");
  });

  it("throws ConfigError for invalid horizonUrl format", () => {
    expect(() => resolveConfig({ network: "testnet", horizonUrl: "not-a-url" })).toThrow(
      ConfigError
    );
    expect(() => resolveConfig({ network: "testnet", horizonUrl: "not-a-url" })).toThrow(
      "Invalid horizonUrl"
    );
  });

  it("throws ConfigError for non-http/https horizonUrl", () => {
    expect(() => resolveConfig({ network: "testnet", horizonUrl: "ftp://example.com" })).toThrow(
      ConfigError
    );
    expect(() => resolveConfig({ network: "testnet", horizonUrl: "ws://example.com" })).toThrow(
      ConfigError
    );
  });

  it("throws ConfigError for null/undefined config", () => {
    // @ts-expect-error testing runtime behavior
    expect(() => resolveConfig(null)).toThrow(ConfigError);
    // @ts-expect-error testing runtime behavior
    expect(() => resolveConfig(undefined)).toThrow(ConfigError);
  });

  it("throws ConfigError for non-object config", () => {
    // @ts-expect-error testing runtime behavior
    expect(() => resolveConfig("testnet")).toThrow(ConfigError);
    // @ts-expect-error testing runtime behavior
    expect(() => resolveConfig(123)).toThrow(ConfigError);
  });

  it("returns ConfigError with correct code for missing network", () => {
    try {
      resolveConfig({});
    } catch (e) {
      expect(isConfigError(e)).toBe(true);
      expect((e as ConfigError).code).toBe("MISSING_REQUIRED");
    }
  });

  it("returns ConfigError with correct code for invalid network", () => {
    try {
      resolveConfig({ network: "invalid" as NetworkPreset });
    } catch (e) {
      expect(isConfigError(e)).toBe(true);
      expect((e as ConfigError).code).toBe("INVALID_NETWORK");
    }
  });

  it("returns ConfigError with correct code for invalid horizonUrl", () => {
    try {
      resolveConfig({ network: "testnet", horizonUrl: "bad" });
    } catch (e) {
      expect(isConfigError(e)).toBe(true);
      expect((e as ConfigError).code).toBe("INVALID_HORIZON_URL");
    }
  });
});

describe("isConfigError", () => {
  it("returns true for ConfigError instances", () => {
    expect(isConfigError(new ConfigError("test", "INVALID_NETWORK"))).toBe(true);
  });

  it("returns false for plain Error", () => {
    expect(isConfigError(new Error("test"))).toBe(false);
  });

  it("returns false for non-errors", () => {
    expect(isConfigError("string")).toBe(false);
    expect(isConfigError(null)).toBe(false);
    expect(isConfigError(123)).toBe(false);
  });
});

describe("SUPPORTED_NETWORKS", () => {
  it("contains exactly testnet and mainnet", () => {
    expect(SUPPORTED_NETWORKS).toEqual(["testnet", "mainnet"]);
  });
});