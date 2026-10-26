/**
 * Tests for the SDK error taxonomy (issue #9).
 *
 * Asserts, for every failure mode, the concrete error type, code,
 * recoverability, cause chaining, and user-friendly messages.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  FraudDetectorError,
  ConfigError,
  ValidationError,
  NotFoundError,
  RateLimitError,
  UpstreamError,
  NetworkError,
  isFraudDetectorError,
  ERROR_CODES,
  type FraudDetectorErrorOptions,
} from "./errors.js";
import { FraudDetector, DefaultHorizonClient, HorizonError, DetectorConfigError } from "./FraudDetector.js";
import { ConfigError as DetailedConfigError } from "./config.js";

const VALID_ACCOUNT = "GABCDEFGHIJKLMNOPQRSTUVWXYZABCDEFGHIJKLMNOPQRSTUVWXYZABCDEF";

const ERROR_CLASSES: Array<[string, (message: string, options?: FraudDetectorErrorOptions) => FraudDetectorError]> = [
  ["ConfigError", (m, o) => new ConfigError(m, o)],
  ["ValidationError", (m, o) => new ValidationError(m, o)],
  ["NotFoundError", (m, o) => new NotFoundError(m, o)],
  ["RateLimitError", (m, o) => new RateLimitError(m, o)],
  ["UpstreamError", (m, o) => new UpstreamError(m, o)],
  ["NetworkError", (m, o) => new NetworkError(m, o)],
];

describe("taxonomy codes", () => {
  it("assigns a distinct, stable code to each taxonomy error type", () => {
    const codes = new Set<string>();

    expect(Object.values(ERROR_CODES)).toHaveLength(6);
    expect(new Set(Object.values(ERROR_CODES)).size).toBe(6);

    for (const [, create] of ERROR_CLASSES) {
      const error = create(`sample-${codes.size}`);
      expect(codes.has(error.code)).toBe(false);
      expect(typeof error.code).toBe("string");
      expect(error.code.length).toBeGreaterThan(0);
      codes.add(error.code);
    }
  });

  it("preserves the documented code for established error classes", () => {
    expect(new ValidationError("x").code).toBe("VALIDATION_ERROR");
    expect(new HorizonError("x").code).toBe("HORIZON_ERROR");
    expect(new DetectorConfigError("x").code).toBe("CONFIG_ERROR");
    expect(new DetailedConfigError("x", "INVALID_NETWORK").code).toBe("INVALID_NETWORK");
  });

  it("gives each error type a meaningful class name", () => {
    expect(new FraudDetectorError("base", "BASE").name).toBe("FraudDetectorError");
    expect(new ValidationError("x").name).toBe("ValidationError");
    expect(new NotFoundError("x").name).toBe("NotFoundError");
    expect(new RateLimitError("x").name).toBe("RateLimitError");
    expect(new UpstreamError("x").name).toBe("UpstreamError");
    expect(new NetworkError("x").name).toBe("NetworkError");
  });
});

describe("taxonomy base behavior", () => {
  it("extends Error for every member", () => {
    for (const [, create] of ERROR_CLASSES) {
      const error = create("sample");
      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(FraudDetectorError);
      expect(isFraudDetectorError(error)).toBe(true);
      expect(typeof error.message).toBe("string");
      expect(typeof error.code).toBe("string");
      expect(typeof error.recoverable).toBe("boolean");
    }
  });

  it("chains the original error on cause", () => {
    const original = new Error("upstream said no");
    const wrapped = new UpstreamError("Scoring hit a temporary problem.", { cause: original });
    expect(wrapped.cause).toBe(original);

    const network = new NetworkError("offline", { cause: new TypeError("fetch failed") });
    expect((network.cause as TypeError).message).toBe("fetch failed");
  });

  it("defaults recoverable to false and allows opting in", () => {
    expect(new ValidationError("x").recoverable).toBe(false);
    expect(new NotFoundError("x").recoverable).toBe(false);
    expect(new UpstreamError("x", { recoverable: false }).recoverable).toBe(false);
    expect(new UpstreamError("x").recoverable).toBe(false);
    expect(new NetworkError("x").recoverable).toBe(true);
    expect(new RateLimitError("x").recoverable).toBe(true);
  });

  it("isFraudDetectorError rejects plain errors and non-errors", () => {
    expect(isFraudDetectorError(new Error("plain"))).toBe(false);
    expect(isFraudDetectorError("VALIDATION_ERROR")).toBe(false);
    expect(isFraudDetectorError(null)).toBe(false);
    expect(isFraudDetectorError(undefined)).toBe(false);
  });

  it("carries optional context fields", () => {
    const notFound = new NotFoundError("missing account", { resourceId: VALID_ACCOUNT });
    expect(notFound.resourceId).toBe(VALID_ACCOUNT);
    expect(new NotFoundError("missing").resourceId).toBeUndefined();

    const rate = new RateLimitError("slow down", { retryAfterMs: 30_000 });
    expect(rate.retryAfterMs).toBe(30_000);
    expect(new RateLimitError("slow").retryAfterMs).toBeUndefined();

    const upstream = new UpstreamError("maintenance", { upstreamStatus: 503 });
    expect(upstream.upstreamStatus).toBe(503);
  });
});

describe("DefaultHorizonClient maps failures to the taxonomy", () => {
  const client = new DefaultHorizonClient("https://horizon.example.com");
  let fetchMock: ReturnType<typeof vi.fn>;

  function respond(status: number, headers: Record<string, string> = {}) {
    fetchMock = vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      statusText: `status-${status}`,
      headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
      json: () => Promise.resolve({}),
    });
    vi.stubGlobal("fetch", fetchMock);
  }

  function failFetch() {
    fetchMock = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    vi.stubGlobal("fetch", fetchMock);
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("HTTP 404 becomes NotFoundError", async () => {
    respond(404);
    await expect(client.getAccount(VALID_ACCOUNT)).rejects.toBeInstanceOf(NotFoundError);
    await expect(client.getAccount(VALID_ACCOUNT)).rejects.toThrow("could not be found");
  });

  it("HTTP 429 becomes a recoverable RateLimitError honoring Retry-After", async () => {
    respond(429, { "retry-after": "2" });
    const error = await client.getAccount(VALID_ACCOUNT).catch((e) => e);
    expect(error).toBeInstanceOf(RateLimitError);
    expect(error.recoverable).toBe(true);
    expect(error.retryAfterMs).toBe(2000);
  });

  it("HTTP 5xx becomes a recoverable UpstreamError with the status", async () => {
    respond(503);
    const error = await client.getAccount(VALID_ACCOUNT).catch((e) => e);
    expect(error).toBeInstanceOf(UpstreamError);
    expect(error.upstreamStatus).toBe(503);
    expect(error.recoverable).toBe(true);
  });

  it("other HTTP failures become UpstreamError without leaking internals", async () => {
    respond(401);
    const error = await client.getAccount(VALID_ACCOUNT).catch((e) => e);
    expect(error).toBeInstanceOf(UpstreamError);
    expect(error.upstreamStatus).toBe(401);
  });

  it("connection failures become a recoverable NetworkError chaining the cause", async () => {
    failFetch();
    const error = await client.getAccount(VALID_ACCOUNT).catch((e) => e);
    expect(error).toBeInstanceOf(NetworkError);
    expect(error.recoverable).toBe(true);
    expect(error.code).toBe("NETWORK_ERROR");
    expect((error.cause as TypeError).message).toBe("fetch failed");
  });

  it("successful responses are unaffected", async () => {
    fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: {},
      json: () => Promise.resolve({ id: VALID_ACCOUNT }),
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(client.getAccount(VALID_ACCOUNT)).resolves.toEqual({ id: VALID_ACCOUNT });
  });
});

describe("scoreAccount preserves taxonomy errors", () => {
  it("surfaces NotFoundError from the client unwrapped", async () => {
    const detector = new FraudDetector({
      network: "testnet",
      horizonClient: {
        getAccount: vi.fn().mockRejectedValue(
          new NotFoundError(`The account ${VALID_ACCOUNT} could not be found.`, { resourceId: VALID_ACCOUNT })
        ),
        getAccountTransactions: vi.fn().mockResolvedValue([]),
      },
    });

    const error = await detector.scoreAccount(VALID_ACCOUNT).catch((e) => e);
    expect(error).toBeInstanceOf(NotFoundError);
    expect(error.code).toBe("NOT_FOUND");
    expect(error.resourceId).toBe(VALID_ACCOUNT);
  });

  it("still classifies unexpected failures as HorizonError", async () => {
    const detector = new FraudDetector({
      network: "testnet",
      horizonClient: {
        getAccount: vi.fn().mockRejectedValue(new Error("Network error")),
        getAccountTransactions: vi.fn().mockResolvedValue([]),
      },
    });

    await expect(detector.scoreAccount(VALID_ACCOUNT)).rejects.toBeInstanceOf(HorizonError);
  });

  it("rejects invalid input with ValidationError before any network call", async () => {
    const detector = new FraudDetector({
      network: "testnet",
      horizonClient: {
        getAccount: vi.fn(),
        getAccountTransactions: vi.fn(),
      },
    });

    await expect(detector.scoreAccount("nope")).rejects.toBeInstanceOf(ValidationError);
    expect(
      (
        detector as unknown as {
          horizon: { getAccount: ReturnType<typeof vi.fn> };
        }
      ).horizon.getAccount
    ).not.toHaveBeenCalled();
  });

  it("wraps helper errors with the original failure on cause", async () => {
    const detector = new FraudDetector({
      network: "testnet",
      horizonClient: {
        getAccount: vi.fn().mockRejectedValue(new Error("Network error")),
        getAccountTransactions: vi.fn().mockResolvedValue([]),
      },
    });

    const error = await detector.scoreAccount(VALID_ACCOUNT).catch((e) => e);
    expect(error).toBeInstanceOf(HorizonError);
    expect(error.recoverable).toBe(true);
    expect((error.cause as Error).message).toBe("Network error");
  });
});
