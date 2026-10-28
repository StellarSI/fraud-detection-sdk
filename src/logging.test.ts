/**
 * Tests for the structured logger (issue #10).
 *
 * Every assertion reads the payload passed to an injected sink, so no
 * real output or network is used (consistent with fixture-only tests).
 */

import { describe, it, expect, vi } from "vitest";
import {
  createLogger,
  redact,
  setLogger,
  getLogger,
  resetLogger,
  asSink,
  type Logger,
  type LogSink,
} from "./logging.js";

/** Captures what the logger emits, keyed by level. */
function capturingSink(): LogSink & { lines: Array<{ level: string } & Record<string, unknown>> } {
  const lines: Array<{ level: string } & Record<string, unknown>> = [];
  const push = (level: string) => (payload: object) => {
    lines.push(payload as { level: string } & Record<string, unknown>);
  };
  return {
    lines,
    debug: push("debug"),
    info: push("info"),
    warn: push("warn"),
    error: push("error"),
  };
}

/** Sink that asserts every payload is plain-JSON-serializable. */
function jsonSink(validate: (payload: object) => void): LogSink {
  const wrapped = (payload: object) => validate(payload);
  return {
    debug: wrapped,
    info: wrapped,
    warn: wrapped,
    error: wrapped,
  };
}

describe("structured logging", () => {
  it("emits structured (JSON-serializable) payloads by default", () => {
    const sink = capturingSink();
    const log = createLogger({ sink });
    log.info("score.complete", { requestId: "req_1", latencyMs: 42 });

    const line = sink.lines[0];
    expect(() => JSON.parse(JSON.stringify(line))).not.toThrow();
    expect(line["level"]).toBe("info");
    expect(line["message"]).toBe("score.complete");
    expect(line["requestId"]).toBe("req_1");
    expect(line["latencyMs"]).toBe(42);
    expect(typeof line["timestamp"]).toBe("string");
  });

  it("has a configurable level that filters lower severities", () => {
    const sink = capturingSink();
    const log = createLogger({ level: "warn", sink });
    log.debug("nope");
    log.info("nope");
    log.warn("warned");
    log.error("failed");

    expect(sink.lines.map((l) => l["message"])).toEqual(["warned", "failed"]);
    expect(log.level).toBe("warn");
  });

  it("supports the full debug/info/warn/error ladder", () => {
    const sink = capturingSink();
    const log = createLogger({ level: "debug", sink });
    log.debug("d", { requestId: "r" });
    log.info("i", { requestId: "r" });
    log.warn("w", { requestId: "r" });
    log.error("e", { requestId: "r" });

    expect(sink.lines.map((l) => l["level"])).toEqual(["debug", "info", "warn", "error"]);
  });

  it("never logs secrets or credentials (#76)", () => {
    const sink = capturingSink();
    const log = createLogger({ level: "debug", sink });
    const liberating = new Error("failed");
    log.error("request failed", {
      requestId: "req_2",
      errorCode: "NETWORK_ERROR",
      // These must all be masked:
      secret: "top-secret-value",
      signingSeed: "SABCDEFGHIJKLM...",
      apiKey: "abc123def456",
      authorization: "Bearer sk_live_123",
      token: "ghp_supersecret",
    });
    void liberating;

    const serialized = JSON.stringify(sink.lines[0]);
    expect(serialized).not.toContain("top-secret-value");
    expect(serialized).not.toContain("SABCDEFGHIJKLM");
    expect(serialized).not.toContain("abc123def456");
    expect(serialized).not.toContain("sk_live_123");
    expect(serialized).not.toContain("ghp_supersecret");
    const payload = sink.lines[0];
    expect(payload["secret"]).toBe("[REDACTED]");
    expect(payload["authorization"]).toBe("[REDACTED]");
  });

  it("redacts G... account IDs and nested secret-shaped values", () => {
    const redacted = redact({
      nested: { privateKey: "AAAA-QR8" },
      list: [true, { seedPhrase: "correct horse battery staple" }],
      address: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHK",
      normal: "safe-value",
      count: 7,
    });

    const serialized = JSON.stringify(redacted);
    expect(serialized).toContain("safe-value");
    expect(serialized).toContain("7");
    // Keys matching the secret pattern are masked wholesale:
    expect(JSON.parse(serialized)["nested"]["privateKey"]).toBe("[REDACTED]");
    expect(JSON.parse(serialized)["list"][1]["seedPhrase"]).toBe("[REDACTED]");
    // Raw account IDs in values are masked too:
    expect(JSON.parse(serialized)["address"]).toBe("[REDACTED]");
  });

  it("supports a custom injected logger/sink", () => {
    const spy = vi.fn();
    const log = createLogger({ sink: { debug: spy, info: spy, warn: spy, error: spy } });
    log.info("hello");
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("adapts a host logger via asSink()", () => {
    const host = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const log = createLogger({ level: "debug", sink: asSink(host) });
    log.debug("via host");
    expect(host.debug).toHaveBeenCalledTimes(1);
    expect(typeof host.debug.mock.calls[0][0]).toBe("string");
    expect(() => JSON.parse(host.debug.mock.calls[0][0])).not.toThrow();
  });

  it("child() loggers inherit and extend base context", () => {
    const sink = capturingSink();
    const log = createLogger({ sink, base: { service: "fraud-detection-sdk" } });
    log.child({ requestId: "req_3" }).info("inside child");

    const line = sink.lines[0];
    expect(line["service"]).toBe("fraud-detection-sdk");
    expect(line["requestId"]).toBe("req_3");
  });

  it("uses the injected clock for deterministic timestamps", () => {
    const sink = capturingSink();
    const fixed = new Date("2026-01-02T03:04:05.000Z").getTime();
    const log = createLogger({ sink, now: () => fixed });
    log.info("tick");
    expect(sink.lines[0]["timestamp"]).toBe("2026-01-02T03:04:05.000Z");
  });

  it("validates payloads are JSON objects with the expected fields", () => {
    const seen: object[] = [];
    const log = createLogger({
      sink: jsonSink((payload) => {
        seen.push(payload);
        expect(typeof payload).toBe("object");
      }),
    });
    log.warn("sample", { errorCode: "RATE_LIMIT", status: 429 });
    expect(seen).toHaveLength(1);
    expect((seen[0] as Record<string, unknown>)["errorCode"]).toBe("RATE_LIMIT");
  });
});

describe("global logger management", () => {
  it("exposes, replaces and resets the shared logger", () => {
    resetLogger();
    const before: Logger = getLogger();
    expect(before.level).toBe("info");

    const sink = capturingSink();
    const replacement = createLogger({ level: "debug", sink });
    setLogger(replacement);
    expect(getLogger()).toBe(replacement);
    getLogger().warn("through global");
    expect(sink.lines.map((l) => l["message"])).toEqual(["through global"]);

    resetLogger();
    expect(getLogger().level).toBe("info");
  });
});
