/**
 * Tests for the shared HTTP error mapping (issue #18).
 *
 * Every documented status code is exercised, plus upstream-detail
 * preservation and the fallback rules for unlisted statuses. No
 * network access: responses are constructed locally.
 */

import { describe, it, expect } from "vitest";
import {
  HTTP_STATUS_ERROR_RULES,
  mapHttpResponseToError,
  parseRetryAfterMs,
  resolveHttpStatusRule,
} from "./errorMapping.js";
import {
  NetworkError,
  NotFoundError,
  RateLimitError,
  UpstreamError,
} from "../errors.js";

function jsonErrorResponse(
  body: unknown,
  status: number,
  headers: Record<string, string> = {}
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("HTTP_STATUS_ERROR_RULES", () => {
  it("assigns exactly one rule per documented status", () => {
    const statuses = HTTP_STATUS_ERROR_RULES.map((rule) => rule.status);
    expect(new Set(statuses).size).toBe(statuses.length);
  });

  it("documents the statuses required by issue #18", () => {
    const byStatus = new Map(HTTP_STATUS_ERROR_RULES.map((rule) => [rule.status, rule]));

    expect(byStatus.get(404)?.kind).toBe("notFound");
    expect(byStatus.get(429)?.kind).toBe("rateLimit");
    expect(byStatus.get(500)?.kind).toBe("upstream");
    expect(byStatus.get(503)?.kind).toBe("upstream");
    expect(byStatus.get(408)?.kind).toBe("network");
  });
});

describe("resolveHttpStatusRule", () => {
  it("falls back to a non-retriable upstream failure for unknown 4xx", () => {
    expect(resolveHttpStatusRule(418)).toMatchObject({
      status: 418,
      kind: "upstream",
      recoverable: false,
    });
  });

  it("falls back to a retriable upstream failure for unknown 5xx", () => {
    expect(resolveHttpStatusRule(599)).toMatchObject({
      status: 599,
      kind: "upstream",
      recoverable: true,
    });
  });
});

describe("mapHttpResponseToError", () => {
  it("maps every documented status onto the correct SDK error type", async () => {
    for (const rule of HTTP_STATUS_ERROR_RULES) {
      const headers = rule.status === 429 ? { "retry-after": "2" } : {};
      const error = await mapHttpResponseToError(
        jsonErrorResponse({ title: "upstream detail" }, rule.status, headers),
        { serviceName: "Horizon" }
      );

      if (rule.kind === "notFound") {
        expect(error).toBeInstanceOf(NotFoundError);
      } else if (rule.kind === "rateLimit") {
        expect(error).toBeInstanceOf(RateLimitError);
        expect((error as RateLimitError).retryAfterMs).toBe(2000);
      } else if (rule.kind === "network") {
        expect(error).toBeInstanceOf(NetworkError);
      } else {
        expect(error).toBeInstanceOf(UpstreamError);
        expect((error as UpstreamError).upstreamStatus).toBe(rule.status);
      }

      expect(error.recoverable).toBe(rule.recoverable);
      expect(error.upstreamDetail?.status).toBe(rule.status);
      expect(error.upstreamDetail?.message).toBe("upstream detail");
      expect(error.message).toContain("Horizon");
    }
  });

  it("keeps the missing resource id on NotFoundError", async () => {
    const error = await mapHttpResponseToError(
      jsonErrorResponse({ title: "Not Found" }, 404),
      { serviceName: "Horizon", resourceId: "GABC" }
    );

    expect(error).toBeInstanceOf(NotFoundError);
    expect((error as NotFoundError).resourceId).toBe("GABC");
    expect(error.message).toContain("could not be found");
  });

  it("preserves upstream message and request id on cause and the error", async () => {
    const error = await mapHttpResponseToError(
      jsonErrorResponse(
        {
          title: "Resource Missing",
          detail: "Account GABC does not exist",
          request_id: "req-42",
        },
        404
      ),
      { serviceName: "Horizon" }
    );

    expect(error.upstreamDetail).toMatchObject({
      status: 404,
      message: "Account GABC does not exist",
      requestId: "req-42",
    });
    expect(error.cause).toMatchObject({
      status: 404,
      requestId: "req-42",
    });
    expect((error.cause as { body: unknown }).body).toMatchObject({
      request_id: "req-42",
    });
  });

  it("falls back to the x-request-id header", async () => {
    const error = await mapHttpResponseToError(
      jsonErrorResponse({ message: "boom" }, 503, { "x-request-id": "hdr-9" }),
      { serviceName: "Horizon" }
    );

    expect(error.upstreamDetail?.requestId).toBe("hdr-9");
  });

  it("keeps a plain-text body instead of throwing", async () => {
    const response = new Response("service unavailable", { status: 503 });
    const error = await mapHttpResponseToError(response, {
      serviceName: "Horizon",
    });

    expect(error).toBeInstanceOf(UpstreamError);
    expect(error.upstreamDetail?.body).toBe("service unavailable");
    expect(error.upstreamDetail?.message).toBe("service unavailable");
  });

  it("tolerates a body that cannot be read", async () => {
    const response = {
      ok: false,
      status: 500,
      statusText: "Server Error",
      url: "https://horizon.example.org/accounts/GABC",
      headers: { get: () => null },
      text: () => Promise.reject(new Error("stream already consumed")),
    } as unknown as Response;

    const error = await mapHttpResponseToError(response, {
      serviceName: "Horizon",
    });

    expect(error).toBeInstanceOf(UpstreamError);
    expect(error.upstreamDetail?.url).toBe(
      "https://horizon.example.org/accounts/GABC"
    );
    expect(error.upstreamDetail?.body).toBeUndefined();
  });
});

describe("parseRetryAfterMs", () => {
  it("converts seconds to milliseconds", () => {
    expect(parseRetryAfterMs("2")).toBe(2000);
  });

  it("returns undefined for missing, zero, or invalid values", () => {
    expect(parseRetryAfterMs(undefined)).toBeUndefined();
    expect(parseRetryAfterMs(null)).toBeUndefined();
    expect(parseRetryAfterMs("")).toBeUndefined();
    expect(parseRetryAfterMs("0")).toBeUndefined();
    expect(parseRetryAfterMs("later")).toBeUndefined();
  });

  it("converts an HTTP date into a bounded delay", () => {
    const future = new Date(Date.now() + 60_000).toUTCString();
    const delay = parseRetryAfterMs(future);
    expect(delay).toBeGreaterThan(0);
    expect(delay).toBeLessThanOrEqual(60_000);
  });
});
