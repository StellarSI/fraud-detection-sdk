/**
 * Tests for the retry wrapper (issue #15).
 *
 * All tests run fully offline against a fake `fetch`. No real delays are
 * incurred: `baseDelay` and `maxDelay` are set to 0 or tiny values.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { withRetry, fetchWithRetry, type RetryOptions } from "./http.js";
import { NetworkError, UpstreamError } from "../errors.js";

const RETRIABLE_STATUS_CODES = [429, 500, 502, 503, 504];

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function failingFetch(status: number, headers: Record<string, string> = {}): typeof fetch {
  return vi.fn().mockResolvedValue(jsonResponse({}, status, headers)) as unknown as typeof fetch;
}

function networkErrorFetch(): typeof fetch {
  return vi.fn().mockRejectedValue(new TypeError("fetch failed")) as unknown as typeof fetch;
}

describe("withRetry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("returns immediately on success without retrying", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await withRetry(fn);
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries transient failures and succeeds on a later attempt", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new UpstreamError("boom", { upstreamStatus: 500, recoverable: true }))
      .mockResolvedValue("ok");
    const result = await withRetry(fn, { retries: 2, baseDelay: 1, maxDelay: 10 });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("does not retry non-retriable errors", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("permanent"));
    await expect(withRetry(fn)).rejects.toThrow("permanent");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("respects noRetry option", async () => {
    const fn = vi.fn().mockRejectedValue(new UpstreamError("boom", { upstreamStatus: 500, recoverable: true }));
    await expect(withRetry(fn, { noRetry: true })).rejects.toBeInstanceOf(UpstreamError);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("honors Retry-After header", async () => {
    const fn = vi.fn().mockRejectedValue(
      new UpstreamError("rate limited", { upstreamStatus: 429, recoverable: true, retryAfterMs: 100 })
    );
    await expect(withRetry(fn, { retries: 1, baseDelay: 1, maxDelay: 10 })).rejects.toBeInstanceOf(
      UpstreamError
    );
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("exhausts retries and throws the last error", async () => {
    const fn = vi.fn().mockRejectedValue(new UpstreamError("always fails", { upstreamStatus: 500, recoverable: true }));
    await expect(withRetry(fn, { retries: 2, baseDelay: 1, maxDelay: 10 })).rejects.toThrow("always fails");
    expect(fn).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
  });

  it("does not retry 4xx client errors", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("bad request", { cause: { status: 400 } }));
    // Simulate via classifyError path: plain Error without recoverable flag is not retriable
    await expect(withRetry(fn)).rejects.toThrow("bad request");
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("fetchWithRetry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("returns the response on success", async () => {
    const fetchImpl = failingFetch(200);
    vi.stubGlobal("fetch", fetchImpl);
    const res = await fetchWithRetry("https://example.org/data");
    expect(res.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("retries on 429 and succeeds later", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({}, 429, { "retry-after": "1" }))
      .mockResolvedValueOnce(jsonResponse({ data: "ok" }, 200));
    vi.stubGlobal("fetch", fetchImpl);
    const res = await fetchWithRetry("https://example.org/data", undefined, { retries: 2, baseDelay: 1, maxDelay: 10 });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toBe("ok");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("retries on 5xx and succeeds later", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({}, 500))
      .mockResolvedValueOnce(jsonResponse({ data: "ok" }, 200));
    vi.stubGlobal("fetch", fetchImpl);
    const res = await fetchWithRetry("https://example.org/data", undefined, { retries: 2, baseDelay: 1, maxDelay: 10 });
    expect(res.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not retry on 400", async () => {
    const fetchImpl = failingFetch(400);
    vi.stubGlobal("fetch", fetchImpl);
    await expect(fetchWithRetry("https://example.org/data")).rejects.toBeInstanceOf(UpstreamError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("wraps network errors in NetworkError and retries", async () => {
    const fetchImpl = networkErrorFetch();
    vi.stubGlobal("fetch", fetchImpl);
    await expect(fetchWithRetry("https://example.org/data", undefined, { retries: 1, baseDelay: 1, maxDelay: 10 })).rejects.toBeInstanceOf(
      NetworkError
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("honors Retry-After on 429", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({}, 429, { "retry-after": "50" }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }, 200));
    vi.stubGlobal("fetch", fetchImpl);
    const res = await fetchWithRetry("https://example.org/data", undefined, { retries: 2, baseDelay: 1, maxDelay: 10 });
    expect(res.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
