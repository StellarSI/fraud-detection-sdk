/**
 * Shared HTTP-to-taxonomy error mapping (issue #18).
 *
 * Horizon and the transaction-analytics-api adapter both return HTTP
 * failures with upstream-specific bodies. Mapping them in one
 * data-driven place keeps every consumer catching the same SDK error
 * types instead of parsing status codes:
 *
 * - 404 / 410 -> {@link NotFoundError}
 * - 408       -> {@link NetworkError} (request timed out upstream)
 * - 429       -> {@link RateLimitError} with `Retry-After` honored
 * - 5xx       -> recoverable {@link UpstreamError}
 * - other 4xx -> non-retriable {@link UpstreamError}
 *
 * The original status, reason phrase, URL, upstream message, and
 * request id are preserved on both `cause` and
 * `error.upstreamDetail` (#18).
 */

import {
  NetworkError,
  NotFoundError,
  RateLimitError,
  UpstreamError,
  type FraudDetectorError,
  type UpstreamErrorDetail,
} from "../errors.js";

/** Taxonomy family a status code maps onto. */
export type HttpErrorKind = "notFound" | "rateLimit" | "upstream" | "network";

/** One row of the data-driven status mapping table. */
export interface HttpStatusRule {
  /** HTTP status this rule applies to. */
  readonly status: number;
  /** SDK error family to construct. */
  readonly kind: HttpErrorKind;
  /** Whether the caller may retry the failed request. */
  readonly recoverable: boolean;
}

/**
 * Explicit rules for the status codes the SDK documents (#18).
 *
 * Extend this table (and add a test) when an upstream introduces a new
 * failure mode; the fallback rules below cover the rest.
 */
export const HTTP_STATUS_ERROR_RULES: readonly HttpStatusRule[] = [
  { status: 400, kind: "upstream", recoverable: false },
  { status: 401, kind: "upstream", recoverable: false },
  { status: 403, kind: "upstream", recoverable: false },
  { status: 404, kind: "notFound", recoverable: false },
  { status: 405, kind: "upstream", recoverable: false },
  { status: 406, kind: "upstream", recoverable: false },
  { status: 408, kind: "network", recoverable: true },
  { status: 409, kind: "upstream", recoverable: false },
  { status: 410, kind: "notFound", recoverable: false },
  { status: 422, kind: "upstream", recoverable: false },
  { status: 425, kind: "upstream", recoverable: true },
  { status: 429, kind: "rateLimit", recoverable: true },
  { status: 500, kind: "upstream", recoverable: true },
  { status: 501, kind: "upstream", recoverable: false },
  { status: 502, kind: "upstream", recoverable: true },
  { status: 503, kind: "upstream", recoverable: true },
  { status: 504, kind: "upstream", recoverable: true },
];

/**
 * Resolves the rule for a status code, falling back by class:
 * unknown 5xx responses are retriable upstream failures, and unknown
 * 4xx responses are permanent client errors.
 *
 * @param status - HTTP status code.
 * @returns The matching rule, always with the requested status.
 */
export function resolveHttpStatusRule(status: number): HttpStatusRule {
  const exact = HTTP_STATUS_ERROR_RULES.find((rule) => rule.status === status);
  if (exact) {
    return exact;
  }
  return {
    status,
    kind: "upstream",
    recoverable: status >= 500,
  };
}

/** Options describing which upstream produced the failure. */
export interface MapHttpErrorOptions {
  /** Human-readable service name used in messages, e.g. "Horizon". */
  readonly serviceName?: string;
  /** Identifier of the missing resource (accounts, transactions, ...). */
  readonly resourceId?: string;
}

/** Reads a header without assuming a full `Headers` implementation. */
function readHeader(response: Response, name: string): string | undefined {
  try {
    const value = response.headers?.get?.(name);
    return value === null || value === undefined ? undefined : value;
  } catch {
    return undefined;
  }
}

/** Parses `Retry-After` (seconds or HTTP date) into milliseconds. */
export function parseRetryAfterMs(value: string | null | undefined): number | undefined {
  if (value === null || value === undefined || value.length === 0) {
    return undefined;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds)) {
    return seconds > 0 ? Math.round(seconds * 1000) : undefined;
  }
  const date = Date.parse(value);
  if (!Number.isNaN(date)) {
    const delay = date - Date.now();
    return delay > 0 ? delay : 0;
  }
  return undefined;
}

/** Type guard for plain JSON objects. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Returns the first non-empty string value for the given keys. */
function firstString(
  record: Record<string, unknown>,
  keys: readonly string[]
): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return undefined;
}

/** Parses a response body without throwing on malformed payloads. */
function parseBody(text: string): unknown {
  if (text.length === 0) {
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/**
 * Reads a failed response body, tolerating partial `Response` mocks and
 * already-consumed streams. Never throws.
 */
async function readResponseBody(response: Response): Promise<unknown> {
  try {
    if (typeof response.text === "function") {
      return parseBody(await response.text());
    }
    if (typeof response.json === "function") {
      return (await response.json()) as unknown;
    }
  } catch {
    // Body is optional detail; ignore unreadable or empty payloads.
  }
  return undefined;
}

/**
 * Extracts vendor detail (status, message, request id, body) from a
 * failed response.
 *
 * @param response - The failed HTTP response.
 * @returns A structured {@link UpstreamErrorDetail}.
 */
export async function extractUpstreamDetail(
  response: Response
): Promise<UpstreamErrorDetail> {
  const body = await readResponseBody(response);
  const record = isRecord(body) ? body : undefined;
  const bodyMessage = record
    ? firstString(record, ["message", "detail", "title", "error"])
    : typeof body === "string"
      ? body.slice(0, 500)
      : undefined;
  const bodyRequestId = record
    ? firstString(record, ["request_id", "requestId", "id"])
    : undefined;
  const headerRequestId = readHeader(response, "x-request-id");
  const url = typeof response.url === "string" && response.url.length > 0
    ? response.url
    : undefined;

  return {
    status: response.status,
    statusText: response.statusText || undefined,
    url,
    message: bodyMessage,
    requestId: bodyRequestId ?? headerRequestId,
    body,
  };
}

/**
 * Maps a failed HTTP response onto the SDK error taxonomy (#18).
 *
 * @param response - A response whose `ok` is false.
 * @param options - Service name and optional resource id.
 * @returns The taxonomy error to throw; never a raw status.
 *
 * @example
 * ```ts
 * if (!response.ok) {
 *   throw await mapHttpResponseToError(response, { serviceName: "Horizon" });
 * }
 * ```
 */
export async function mapHttpResponseToError(
  response: Response,
  options: MapHttpErrorOptions = {}
): Promise<FraudDetectorError> {
  const serviceName = options.serviceName ?? "the upstream service";
  const status = response.status;
  const rule = resolveHttpStatusRule(status);
  const detail = await extractUpstreamDetail(response);
  const retryAfterMs = parseRetryAfterMs(readHeader(response, "retry-after"));

  switch (rule.kind) {
    case "notFound":
      return new NotFoundError(
        `The requested resource could not be found on ${serviceName}. It may not exist, or you may be querying the wrong network.`,
        {
          resourceId: options.resourceId,
          cause: detail,
          upstreamDetail: detail,
        }
      );

    case "rateLimit":
      return new RateLimitError(
        `${serviceName} rate limit reached; slow down and retry later.`,
        {
          retryAfterMs,
          recoverable: rule.recoverable,
          cause: detail,
          upstreamDetail: detail,
        }
      );

    case "network":
      return new NetworkError(
        `${serviceName} did not respond before the request timed out (HTTP ${status}). Check connectivity and try again.`,
        {
          recoverable: rule.recoverable,
          cause: detail,
          upstreamDetail: detail,
        }
      );

    case "upstream":
    default:
      return new UpstreamError(
        status >= 500
          ? `${serviceName} reported a temporary internal error (HTTP ${status}). Please try again soon.`
          : `${serviceName} rejected the request (HTTP ${status}). Double-check the account ID and options, then try again.`,
        {
          upstreamStatus: status,
          recoverable: rule.recoverable,
          cause: detail,
          upstreamDetail: detail,
        }
      );
  }
}
