/**
 * Retry wrapper with exponential backoff and jitter (issue #15).
 *
 * Provides {@link withRetry} which wraps any async function with bounded
 * retries for transient failures only:
 *
 * - Retries on HTTP 429, 500, 502, 503, 504 and network errors
 * - Never retries on 4xx client errors (except 429)
 * - Respects `Retry-After` response header when present
 * - Uses exponential backoff with jitter
 * - All delays are configurable and disable-able for tests
 *
 * The Horizon client wires its retrying transport in underneath this
 * wrapper (#14 references this module as its retry layer).
 */

import {
  NetworkError,
  RateLimitError,
  UpstreamError,
  type FraudDetectorErrorOptions,
} from "../errors.js";

/** Options for {@link withRetry}. */
export interface RetryOptions {
  /** Maximum number of retry attempts. Default: 2 (1 initial + 2 retries). */
  retries?: number;
  /** Base delay in ms for exponential backoff. Default: 250. */
  baseDelay?: number;
  /** Maximum delay cap in ms. Default: 4000. */
  maxDelay?: number;
  /** Set to true to disable all retries (useful for tests). Default: false. */
  noRetry?: boolean;
}

/** Transient HTTP status codes that warrant a retry. */
const RETRIABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);

/** Parses Retry-After header value into milliseconds. */
function parseRetryAfterMs(value: string | null): number | undefined {
  if (value == null || value.length === 0) return undefined;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : undefined;
}

/**
 * Classifies an error as retriable or not.
 *
 * Returns `{ retriable: true, retryAfterMs? }` when the caller may retry,
 * or `{ retriable: false }` when the error is permanent.
 */
function classifyError(error: unknown): { retriable: boolean; retryAfterMs?: number } {
  // SDK taxonomy errors carry their own recoverable flag
  if (
    error instanceof Error &&
    "recoverable" in error &&
    typeof (error as { recoverable?: boolean }).recoverable === "boolean"
  ) {
    const recoverable = (error as { recoverable?: boolean }).recoverable;
    if (!recoverable) return { retriable: false };
    const retryAfterMs = (error as { retryAfterMs?: number }).retryAfterMs;
    if (retryAfterMs !== undefined) return { retriable: true, retryAfterMs };
    return { retriable: true };
  }

  // Abort/timeout errors from fetch are retriable
  if (error instanceof Error) {
    if (error.name === "AbortError") return { retriable: true };
    const msg = error.message.toLowerCase();
    if (msg.includes("network") || msg.includes("fetch") || msg.includes("timeout")) {
      return { retriable: true };
    }
  }

  return { retriable: false };
}

/** Sleeps for `ms` milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Computes jittered delay: base + random(0, base * 0.1). */
function jitter(base: number): number {
  return Math.round(Math.random() * base * 0.1);
}

/**
 * Wraps an async function with bounded retries for transient failures.
 *
 * @param fn - Async function to wrap.
 * @param options - Retry configuration.
 * @returns The result of `fn()` on success.
 * @throws The last error if all retries are exhausted.
 *
 * @example
 * ```ts
 * const result = await withRetry(
 *   () => fetch("https://api.example.com/data"),
 *   { retries: 3, baseDelay: 500, maxDelay: 8000 }
 * );
 * ```
 */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const retries = options.retries ?? 2;
  const baseDelay = options.baseDelay ?? 250;
  const maxDelay = options.maxDelay ?? 4000;
  const noRetry = options.noRetry ?? false;

  if (noRetry) {
    return fn();
  }

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const { retriable, retryAfterMs } = classifyError(error);
      if (!retriable) throw error;
      if (attempt >= retries) break;

      let delayMs: number;
      if (typeof retryAfterMs === "number" && retryAfterMs > 0) {
        delayMs = retryAfterMs + jitter(retryAfterMs);
      } else {
        const backoff = Math.min(baseDelay * 2 ** attempt, maxDelay);
        delayMs = backoff + jitter(backoff);
      }
      await sleep(delayMs);
    }
  }
  throw lastError;
}

/**
 * Builds a retriable fetch closure for a URL.
 *
 * Wraps `fetch(url)` so that transient HTTP responses (429, 5xx) and
 * network errors are retried via {@link withRetry}. Non-retriable
 * responses (other 4xx) throw immediately.
 *
 * @param url - URL to fetch.
 * @param init - Fetch options.
 * @param retryOptions - Retry configuration.
 * @returns The fetch Response on success.
 */
export async function fetchWithRetry(
  url: string,
  init?: RequestInit,
  retryOptions: RetryOptions = {}
): Promise<Response> {
  return withRetry(async () => {
    let response: Response;
    try {
      response = await fetch(url, init);
    } catch (error) {
      throw new NetworkError(
        `Could not reach ${url}. Check your internet connection and the configured URL, then try again.`,
        { cause: error }
      );
    }

    if (response.ok) return response;

    const status = response.status;
    const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));

    if (status === 404) {
      throw new UpstreamError(`Resource not found at ${url} (HTTP 404)`, {
        upstreamStatus: status,
        recoverable: false,
      });
    }
    if (RETRIABLE_STATUS_CODES.has(status)) {
      throw new UpstreamError(`Upstream returned HTTP ${status}`, {
        upstreamStatus: status,
        recoverable: true,
        cause: { status, retryAfterMs },
      });
    }
    // Other 4xx: permanent client error, never retry
    throw new UpstreamError(`Upstream rejected the request (HTTP ${status})`, {
      upstreamStatus: status,
      recoverable: false,
    });
  }, retryOptions);
}
