/**
 * Structured logging and observability hooks (issue #10).
 *
 * Minimal, dependency-free structured logger used by the detector
 * (#3), the Horizon clients (#12-#16) and score aggregation (#8).
 *
 * Contract:
 * - Output is one JSON object per line (JSON Lines) — non-ANSI and
 *   machine-parseable by default (see #70).
 * - Levels: debug < info < warn < error; the active level is
 *   configurable and logs below it are dropped.
 * - A custom sink is always injectable, so consumers can route output
 *   into their existing observability stack.
 * - Redaction is structural: any field whose key matches a
 *   secret-looking pattern is replaced with "[REDACTED]" before
 *   serialization, so keys, seeds and auth headers never reach the
 *   sink (#76).
 * - Enough request-context (request id, latency, error code) is
 *   captured to audit a scoring run without logging payload content.
 *
 * The default global logger is a singleton so every module shares one
 * configuration; `createLogger` builds isolated instances for tests
 * or additional pipelines.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

/** Numeric rank per level; only messages with rank >= threshold emit. */
const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export const DEFAULT_LOG_LEVEL: LogLevel = "info";

/** Where log lines are written. `_meta` exists for sink plumbing/tests. */
export interface LogDestination {
  /** Metadata recorded with each line, useful for APM-style indexes. */
  _meta?: Record<string, unknown>;
}

/** A sink receives fully-built log method descriptors. */
export interface LogSink {
  debug(payload: object): void;
  info(payload: object): void;
  warn(payload: object): void;
  error(payload: object): void;
}

/** A host logger (e.g. pino, winston) can be adapted wholesale. */
export interface HostLogger {
  debug(...args: unknown[]): unknown;
  info(...args: unknown[]): unknown;
  warn(...args: unknown[]): unknown;
  error(...args: unknown[]): unknown;
}

/** Optional per-call fields attached to a log event. */
export interface LogContext {
  /** Correlates all logs of one scoring op/request. */
  requestId?: string;
  /** Machine-readable error code from the shared taxonomy (#9). */
  errorCode?: string;
  /** Operation or request latency in milliseconds. */
  latencyMs?: number;
  /** Numeric HTTP/upstream status when applicable. */
  status?: number;
  [key: string]: unknown;
}

/** Keys whose values must never reach the sink (#76). */
const SECRET_KEY_PATTERN =
  /(secret|seed|password|passwd|passphrase|token|api[-_]?key|authorization|auth[-_]?header|credential|private[-_]?key|cookie)/i;

/** String values that look like raw credentials are masked too. */
const SECRET_VALUE_PATTERN =
  /^[SA]\b|^S[A-Z]{10,}$|^G[A-Z2-7]{55}$|^(Bearer|Basic)\s+/i;

/**
 * Replaces secret-looking entries with "[REDACTED]".
 *
 * Structural redaction: recurses objects/arrays and masks values by
 * key pattern first, then by value shape, so a misplaced secret cannot
 * leak through a differently named field.
 *
 * @param value - Any payload attached to a log event.
 */
export function redact(value: unknown): unknown {
  if (typeof value === "string") {
    return SECRET_VALUE_PATTERN.test(value) ? "[REDACTED]" : value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redact(entry));
  }
  if (value && typeof value === "object") {
    const redacted: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY_PATTERN.test(key) && typeof entry !== "object") {
        redacted[key] = "[REDACTED]";
      } else {
        redacted[key] = redact(entry);
      }
    }
    return redacted;
  }
  return value;
}

/** Options for {@link createLogger}. */
export interface LoggerOptions {
  /** Minimum level to emit. Default: "info". */
  level?: LogLevel;
  /** Custom sink; defaults to writing JSON lines on stdout/stderr. */
  sink?: LogSink;
  /** Default context merged into every event (service name, ...). */
  base?: Record<string, unknown>;
  /** Clock used for timestamps; injectable for deterministic tests. */
  now?: () => number;
}

/**
 * Structured JSON-lines logger.
 *
 * @example
 * const log = createLogger({ level: "debug" });
 * log.info("score.complete", { requestId: "req_1", latencyMs: 42 });
 */
export interface Logger {
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
  /** Returns a logger with `context` merged into every future event. */
  child(context: LogContext): Logger;
  /** Currently active minimum level. */
  readonly level: LogLevel;
}

/** Builds an isolated structured logger (see module docs for the contract). */
export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? DEFAULT_LOG_LEVEL;
  const threshold = LEVEL_RANK[level];
  const now = options.now ?? (() => Date.now());
  const base = options.base ?? {};

  const sink: LogSink =
    options.sink ??
    {
      debug: jsonLineSink("debug"),
      info: jsonLineSink("info"),
      warn: jsonLineSink("warn"),
      error: jsonLineSink("error"),
    };

  function emit(severity: LogLevel, message: string, context?: LogContext): void {
    if (LEVEL_RANK[severity] < threshold) {
      return;
    }
    const payload = {
      level: severity,
      message,
      timestamp: new Date(now()).toISOString(),
      ...base,
      ...redact(context ?? {}) as Record<string, unknown>,
    };
    sink[severity](payload);
  }

  return {
    get level(): LogLevel {
      return level;
    },
    debug(message, context) {
      emit("debug", message, context);
    },
    info(message, context) {
      emit("info", message, context);
    },
    warn(message, context) {
      emit("warn", message, context);
    },
    error(message, context) {
      emit("error", message, context);
    },
    child(context) {
      return createLogger({
        ...options,
        base: { ...base, ...redact(context) as Record<string, unknown> },
      });
    },
  };
}

/** Default sink: one JSON object per line on stdout (errors on stderr). */
function jsonLineSink(severity: LogLevel) {
  return (payload: object): void => {
    const line = JSON.stringify(payload);
    if (severity === "error") {
      process.stderr.write(line + "\n");
    } else {
      process.stdout.write(line + "\n");
    }
  };
}

/** Adapts a host logger (pino/winston/etc.) into the SDK interface. */
export function asSink(host: HostLogger): LogSink {
  return {
    debug: (payload) => void host.debug(JSON.stringify(payload)),
    info: (payload) => void host.info(JSON.stringify(payload)),
    warn: (payload) => void host.warn(JSON.stringify(payload)),
    error: (payload) => void host.error(JSON.stringify(payload)),
  };
}

/** The shared process-wide logger (`setLogger` and `getLogger` manage it). */
let globalLogger: Logger = createLogger();

/** Replaces the shared logger (e.g. to lower the level or inject a sink). */
export function setLogger(logger: Logger): void {
  globalLogger = logger;
}

/** Returns the shared process-wide logger. */
export function getLogger(): Logger {
  return globalLogger;
}

/** Resets the shared logger to a fresh default (useful in tests). */
export function resetLogger(): void {
  globalLogger = createLogger();
}
