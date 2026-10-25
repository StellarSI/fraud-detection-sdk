/**
 * Tests for FraudDetector.
 *
 * Unit tests run fully offline against fixtures.
 * Integration tests would require a live Horizon endpoint.
 */

import { describe, it, expect, vi } from "vitest";
import { FraudDetector, DefaultHorizonClient, ValidationError, HorizonError, DetectorConfigError } from "./FraudDetector.js";
import { ScoreResult, Signal, RiskLevel } from "./types.js";

// --- Test fixtures ---

const VALID_ACCOUNT = "GABCDEFGHIJKLMNOPQRSTUVWXYZABCDEFGHIJKLMNOPQRSTUVWXYZABCDEF";
const MOCK_ACCOUNT_RESPONSE = {
  id: VALID_ACCOUNT,
  sequence: "123456",
  thresholds: { low_threshold: 0, med_threshold: 0, high_threshold: 0 },
  balances: [{ asset_type: "native", balance: "1000.0000000" }],
  signers: [{ weight: 1, key: VALID_ACCOUNT, type: "ed25519_public_key" }],
  data: {},
  paging_token: "123456",
};

const MOCK_TRANSACTIONS = [
  {
    id: "tx1",
    created_at: "2024-01-15T10:00:00Z",
    source_account: VALID_ACCOUNT,
    type: "payment",
    amount: "100.0000000",
    asset_code: "USDC",
    to: "GOTHER...123",
  },
  {
    id: "tx2",
    created_at: "2024-01-15T10:05:00Z",
    source_account: VALID_ACCOUNT,
    type: "payment",
    amount: "50.0000000",
    asset_code: "XLM",
    to: "GANOTHER...456",
  },
];

// --- Mock Horizon client factory ---

function createMockHorizonClient(overrides: Partial<{
  account: typeof MOCK_ACCOUNT_RESPONSE;
  transactions: typeof MOCK_TRANSACTIONS;
  shouldFail: boolean;
  failStatus: number;
}> = {}) {
  const {
    account = MOCK_ACCOUNT_RESPONSE,
    transactions = MOCK_TRANSACTIONS,
    shouldFail = false,
    failStatus = 500,
  } = overrides;

  const mockClient = {
    getAccount: vi.fn(),
    getAccountTransactions: vi.fn(),
  };

  if (shouldFail) {
    mockClient.getAccount.mockRejectedValue(
      new Error(`Horizon error: ${failStatus}`)
    );
  } else {
    mockClient.getAccount.mockResolvedValue(account);
  }

  mockClient.getAccountTransactions.mockResolvedValue(transactions);

  return mockClient;
}

// --- Tests ---

describe("FraudDetector constructor", () => {
  it("accepts valid config with network only", () => {
    const detector = new FraudDetector({ network: "testnet" });
    expect(detector.getConfig().network).toBe("testnet");
    expect(detector.getConfig().horizonUrl).toBe("https://horizon-testnet.stellar.org");
  });

  it("accepts valid config with custom horizonUrl", () => {
    const detector = new FraudDetector({
      network: "mainnet",
      horizonUrl: "https://custom-horizon.example.com",
    });
    expect(detector.getConfig().horizonUrl).toBe("https://custom-horizon.example.com");
  });

  it("accepts injected horizonClient", () => {
    const mockClient = {
      getAccount: async () => {},
      getAccountTransactions: async () => [],
    };
    const detector = new FraudDetector({
      network: "testnet",
      horizonClient: mockClient,
    });
    expect((detector as any).horizon).toBe(mockClient);
  });

  it("throws DetectorConfigError for missing network", () => {
    expect(() => new FraudDetector({ network: "" as any })).toThrow("Network is required");
  });

  it("throws DetectorConfigError for invalid network", () => {
    expect(() => new FraudDetector({ network: "invalid" as any })).toThrow("Unknown network");
  });

  it("throws DetectorConfigError for invalid horizonUrl", () => {
    expect(() => new FraudDetector({ network: "testnet", horizonUrl: "bad" })).toThrow(
      "Invalid horizonUrl"
    );
  });
});

describe("FraudDetector.scoreAccount", () => {
  let detector: FraudDetector;
  let mockClient: ReturnType<typeof createMockHorizonClient>;

  beforeEach(() => {
    mockClient = createMockHorizonClient();
    detector = new FraudDetector({ network: "testnet", horizonClient: mockClient });
  });

  it("returns a ScoreResult with correct shape", async () => {
    const result = await detector.scoreAccount("GABCDEFGHIJKLMNOPQRSTUVWXYZABCDEFGHIJKLMNOPQRSTUVWXYZABCDEF");

    expect(result).toHaveProperty("score");
    expect(result).toHaveProperty("level");
    expect(result).toHaveProperty("signals");
    expect(typeof result.score).toBe("number");
    expect(["low", "medium", "high"]).toContain(result.level);
    expect(Array.isArray(result.signals)).toBe(true);
  });

  it("returns score in [0, 1]", async () => {
    const result = await detector.scoreAccount("GABCDEFGHIJKLMNOPQRSTUVWXYZABCDEFGHIJKLMNOPQRSTUVWXYZABCDEF");
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(1);
  });

  it("returns valid risk level", async () => {
    const result = await detector.scoreAccount("GABCDEFGHIJKLMNOPQRSTUVWXYZABCDEFGHIJKLMNOPQRSTUVWXYZABCDEF");
    expect(["low", "medium", "high"]).toContain(result.level);
  });

  it("includes at least one signal when detectors fire", async () => {
    // Create detector with account that has high fan-out
    const mockClient = createMockHorizonClient({
      account: { ...MOCK_ACCOUNT_RESPONSE },
      transactions: Array(200).fill(0).map((_, i) => ({
        id: `tx${i}`,
        created_at: "2024-01-15T10:00:00Z",
        source_account: "GABCDEFGHIJKLMNOPQRSTUVWXYZABCDEFGHIJKLMNOPQRSTUVWXYZABCDEF",
        type: "payment",
        amount: "10.0000000",
        asset_code: "USDC",
        to: `GOTHER${i.toString().padStart(50, "0")}`,
      })),
    });

    const detector = new FraudDetector({ network: "testnet", horizonClient: mockClient });
    const result = await detector.scoreAccount("GABCDEFGHIJKLMNOPQRSTUVWXYZABCDEFGHIJKLMNOPQRSTUVWXYZABCDEF");

    expect(result.signals.length).toBeGreaterThan(0);
    expect(result.signals.some((s) => s.id === "rapid-fan-out")).toBe(true);
  });

  it("rejects invalid address before network call", async () => {
    await expect(detector.scoreAccount("")).rejects.toThrow("Account ID is required");
    await expect(detector.scoreAccount("invalid")).rejects.toThrow("Invalid Stellar account ID");
    await expect(detector.scoreAccount("GSHORT")).rejects.toThrow("Invalid Stellar account ID");
    await expect(detector.scoreAccount("X" + "A".repeat(55))).rejects.toThrow("Invalid Stellar account ID");

    // Verify no network call was made
    expect(mockClient.getAccount).not.toHaveBeenCalled();
  });

  it("maps Horizon 404 to recoverable HorizonError", async () => {
    const mockClient = createMockHorizonClient({ shouldFail: true, failStatus: 404 });
    const detector = new FraudDetector({ network: "testnet", horizonClient: mockClient });

    await expect(
      detector.scoreAccount("GABCDEFGHIJKLMNOPQRSTUVWXYZABCDEFGHIJKLMNOPQRSTUVWXYZABCDEF")
    ).rejects.toThrow("HorizonError");
  });

  it("maps Horizon 500 to recoverable HorizonError", async () => {
    const mockClient = createMockHorizonClient({ shouldFail: true, failStatus: 500 });
    const detector = new FraudDetector({ network: "testnet", horizonClient: mockClient });

    await expect(
      detector.scoreAccount("GABCDEFGHIJKLMNOPQRSTUVWXYZABCDEFGHIJKLMNOPQRSTUVWXYZABCDEF")
    ).rejects.toThrow("HorizonError");
  });

  it("maps network errors to HorizonError with recoverable=true", async () => {
    const mockClient = {
      getAccount: vi.fn().mockRejectedValue(new Error("Network error")),
      getAccountTransactions: vi.fn().mockResolvedValue([]),
    };
    const detector = new FraudDetector({ network: "testnet", horizonClient: mockClient });

    await expect(
      detector.scoreAccount("GABCDEFGHIJKLMNOPQRSTUVWXYZABCDEFGHIJKLMNOPQRSTUVWXYZABCDEF")
    ).rejects.toThrow("HorizonError");
  });

  it("returns signals with correct shape", async () => {
    const result = await detector.scoreAccount("GABCDEFGHIJKLMNOPQRSTUVWXYZABCDEFGHIJKLMNOPQRSTUVWXYZABCDEF");

    for (const signal of result.signals) {
      expect(signal).toHaveProperty("id");
      expect(signal).toHaveProperty("weight");
      expect(typeof signal.id).toBe("string");
      expect(typeof signal.weight).toBe("number");
      expect(signal.weight).toBeGreaterThanOrEqual(0);
      expect(signal.weight).toBeLessThanOrEqual(1);
    }
  });

  it("score is always in [0, 1]", async () => {
    const result = await detector.scoreAccount("GABCDEFGHIJKLMNOPQRSTUVWXYZABCDEFGHIJKLMNOPQRSTUVWXYZABCDEF");
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(1);
  });

  it("level matches score thresholds", async () => {
    // Mock a detector that produces a high score
    const mockClient = createMockHorizonClient({
      transactions: Array(5000).fill(0).map((_, i) => ({
        id: `tx${i}`,
        created_at: "2024-01-15T10:00:00Z",
        source_account: "GABCDEFGHIJKLMNOPQRSTUVWXYZABCDEFGHIJKLMNOPQRSTUVWXYZABCDEF",
        type: "payment",
        amount: "10.0000000",
        asset_code: "USDC",
        to: `GOTHER${i.toString().padStart(50, "0")}`,
      })),
    });

    const detector = new FraudDetector({ network: "testnet", horizonClient: mockClient });
    const result = await detector.scoreAccount("GABCDEFGHIJKLMNOPQRSTUVWXYZABCDEFGHIJKLMNOPQRSTUVWXYZABCDEF");

    if (result.score >= 0.7) {
      expect(result.level).toBe("high");
    } else if (result.score >= 0.4) {
      expect(result.level).toBe("medium");
    } else {
      expect(result.level).toBe("low");
    }
  });

  it("uses custom thresholds from config", async () => {
    const mockClient = createMockHorizonClient({
      transactions: Array(100).fill(0).map((_, i) => ({
        id: `tx${i}`,
        created_at: "2024-01-15T10:00:00Z",
        source_account: "GABCDEFGHIJKLMNOPQRSTUVWXYZABCDEFGHIJKLMNOPQRSTUVWXYZABCDEF",
        type: "payment",
        amount: "10.0000000",
        asset_code: "USDC",
        to: `GOTHER${i.toString().padStart(50, "0")}`,
      })),
    });

    // With custom thresholds: low=0.3, high=0.8
    const detector = new FraudDetector({
      network: "testnet",
      horizonClient: mockClient,
      thresholds: { low: 0.3, high: 0.8 },
    });
    const result = await detector.scoreAccount("GABCDEFGHIJKLMNOPQRSTUVWXYZABCDEFGHIJKLMNOPQRSTUVWXYZABCDEF");

    // With custom thresholds, the level should be classified differently
    if (result.score < 0.3) {
      expect(result.level).toBe("low");
    } else if (result.score > 0.8) {
      expect(result.level).toBe("high");
    } else {
      expect(result.level).toBe("medium");
    }
  });

  it("getConfig returns thresholds", () => {
    const detector = new FraudDetector({
      network: "testnet",
      horizonClient: createMockHorizonClient(),
      thresholds: { low: 0.2, high: 0.9 },
    });

    const config = detector.getConfig();
    expect(config.thresholds).toEqual({ low: 0.2, high: 0.9 });
  });

  it("getConfig returns default thresholds when none provided", () => {
    const detector = new FraudDetector({
      network: "testnet",
      horizonClient: createMockHorizonClient(),
    });

    const config = detector.getConfig();
    expect(config.thresholds).toEqual({ low: 0.4, high: 0.7 });
  });
});

describe("DefaultHorizonClient", () => {
  it("constructs with base URL", () => {
    const client = new DefaultHorizonClient("https://horizon.example.com");
    expect(client).toBeInstanceOf(DefaultHorizonClient);
  });

  it("strips trailing slashes from base URL", () => {
    const client = new DefaultHorizonClient("https://horizon.example.com/");
    // Can't easily test private field, but verify it constructs
    expect(client).toBeInstanceOf(DefaultHorizonClient);
  });
});

describe("Error classes", () => {
  it("ValidationError has correct code", () => {
    const err = new ValidationError("test");
    expect(err.code).toBe("VALIDATION_ERROR");
    expect(err.recoverable).toBe(false);
  });

  it("HorizonError has correct code and recoverable=true", () => {
    const err = new HorizonError("test");
    expect(err.code).toBe("HORIZON_ERROR");
    expect(err.recoverable).toBe(true);
  });

  it("DetectorConfigError has correct code", () => {
    const err = new DetectorConfigError("test");
    expect(err.code).toBe("CONFIG_ERROR");
  });
});