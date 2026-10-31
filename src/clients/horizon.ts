/**
 * Horizon REST client for account fetches (issue #12).
 *
 * Reads account data straight from Horizon (`README.md:33`: "bring your
 * own Horizon endpoint"), the data source that account-level features
 * (#21, #23) and the detectors (#29-#36) consume.
 *
 * Contract:
 * - `getAccount(address)` validates the address *before* any network
 *   call and rejects invalid input with {@link ValidationError} (#75).
 * - Transport and HTTP failures are mapped onto the shared taxonomy
 *   (issue #9): unknown accounts return 404 → {@link NotFoundError} (#18),
 *   timeouts/unreachable endpoints → {@link NetworkError}, 429 →
 *   {@link RateLimitError} with the server-provided `Retry-After`
 *   honored by the retry wrapper (#15).
 * - Callers never see raw Horizon JSON: the response is normalized into
 *   an {@link Account} shape so feature code stays decoupled from the
 *   upstream wire format.
 */

import {
  NetworkError,
  NotFoundError,
  RateLimitError,
  UpstreamError,
  ValidationError,
  type FraudDetectorErrorOptions,
} from "../errors.js";

/* ------------------------------------------------------------------ */
/* Normalized account shape                                            */
/* ------------------------------------------------------------------ */

/** A native (XLM) or issued-asset balance, already converted. */
export interface AccountBalance {
  /** Asset code: "XLM" for native, otherwise the issued asset code. */
  code: string;
  /** Issuer account id; undefined for the native asset. */
  issuer?: string;
  /** Horizon asset type ("native", "credit_alphanum4", ...). */
  type: string;
  /** Balance converted from stroops / 7-decimal string to a float. */
  amount: number;
  /** Whether the issuing asset has clawback enabled. */
  clawbackEnabled: boolean;
  /** Whether this account is authorized to hold the asset. */
  authorized: boolean;
}

/** A signer on the account, already converted. */
export interface AccountSigner {
  /** Public key of the signer. */
  key: string;
  /** Signature threshold weight (0 = disabled). */
  weight: number;
  /** Horizon signer type ("ed25519_public_key", ...). */
  type: string;
}

/** Normalized Stellar account. Feature code consumes this, never raw JSON. */
export interface Account {
  /** The account ID (G...). */
  id: string;
  /** Current sequence number as a Number (may exceed 2^53 rarely; string kept too). */
  sequence: number;
  /** Raw sequence string from Horizon for exact fidelity. */
  sequenceString: string;
  /** Medium signature threshold. */
  signatureThreshold: number;
  /** Subentry count (trustlines + signers + offers + data entries). */
  subentryCount: number;
  /** Signature thresholds (0-255), delicensed to plain numbers. */
  thresholds: { low: number; medium: number; high: number };
  /** Normalized balances, native first. */
  balances: AccountBalance[];
  /** Normalized signers, ordered by descending weight. */
  signers: AccountSigner[];
  /** Inflation destination, if set. */
  inflationDestination?: string;
  /** Home domain listed on the account, if any. */
  homeDomain?: string;
  /** Arbitrary key/value data entries set on the account. */
  data: Record<string, string>;
  /** Ledger in which the account was last touched. */
  lastLedger: number;
  /** Horizon paging token for pagination callers. */
  pagingToken: string;
}

/* ------------------------------------------------------------------ */
/* Address validation (#75)                                            */
/* ------------------------------------------------------------------ */

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
/** Raw Ed25519 payload length is 32 bytes; Verkey 'G' version byte + 32B data + 2B CRC16 = 56. */
const ADDRESS_LENGTH = 56;

/**
 * Computes CRC-16/XMODEM, the checksum Stellar attaches to encoded keys.
 *
 * @param bytes - Bytes covered by the checksum (payload + version byte).
 */
function crc16Xmodem(bytes: Uint8Array): number {
  let crc = 0x0000;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) {
      crc = crc & 0x8000 ? (crc << 1) ^ 0x1021 : crc << 1;
      crc &= 0xffff;
    }
  }
  return crc;
}

/** Decodes a base32 address into its 35 raw bytes (1 version + 32 payload + 2 CRC). */
function base32Decode(address: string): number[] {
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of address) {
    const value = BASE32_ALPHABET.indexOf(char);
    if (value < 0) {
      throw new Error(`invalid character: ${char}`);
    }
    buffer = (buffer << 5) | value;
    bits += 5;
    if (bits >= 8) {
      bytes.push((buffer >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return bytes;
}

/**
 * Validates a Stellar Ed25519 account ID (G...): 56 chars, correct
 * base32 alphabet, and a matching CRC-16 checksum (issue #75).
 *
 * @param address - Candidate address, expected to be a G... string.
 * @throws {ValidationError} When the address is not a valid account ID.
 */
export function validateAccountId(address: string): void {
  if (typeof address !== "string" || address.length === 0) {
    throw new ValidationError("Stellar account ID is required");
  }
  if (address.length !== ADDRESS_LENGTH) {
    throw new ValidationError(
      `Stellar account ID must be exactly ${ADDRESS_LENGTH} characters, got ${address.length}`
    );
  }
  if (!address.startsWith("G")) {
    throw new ValidationError(
      'Stellar account ID must start with the version byte "G" (Ed25519 public key)'
    );
  }
  if (!/^[A-Z2-7]+$/.test(address)) {
    throw new ValidationError(
      "Stellar account ID must contain only valid base32 characters (A-Z and 2-7)"
    );
  }
  try {
    const bytes = base32Decode(address);
    if (bytes.length !== 35) {
      throw new Error(`expected 35 decoded bytes, got ${bytes.length}`);
    }
    const version = bytes[0];
    const payload = bytes.slice(1, 33);
    const checksum = (bytes[33] << 8) | bytes[34];
    if (version !== 6 << 3 /* Ed25519 public key 'G' */) {
      throw new Error(`unexpected version byte: ${version}`);
    }
    if (crc16Xmodem(Uint8Array.from(payload)) !== checksum) {
      throw new Error("checksum mismatch");
    }
  } catch (error) {
    throw new ValidationError(
      `Stellar account ID is not a valid encoded Ed25519 key: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error }
    );
  }
}

/* ------------------------------------------------------------------ */
/* Generic pagination (#14)                                            */
/* ------------------------------------------------------------------ */

/** A single page returned by a cursor-paginated resource. */
export interface Page<T> {
  /** Normalized records belonging to this page. */
  records: T[];
  /**
   * Opaque cursor for the following page, or `undefined` when this is the
   * last page. Supplying it lets {@link paginate} keep walking until the
   * resource is exhausted.
   */
  nextCursor?: string;
}

/**
 * Fetches one page of a paginated resource starting at `cursor`.
 * Implementations should return an empty `records` array (or omit
 * `nextCursor`) to signal the end of the collection.
 */
export type FetchPage<T> = (cursor?: string) => Promise<Page<T>>;

/** Options controlling {@link paginate}. */
export interface PaginateOptions {
  /**
   * Maximum total items to yield across every page. The limit is honored
   * exactly: iteration stops as soon as it is reached, even mid-page.
   * Defaults to {@link DEFAULT_PAGINATION_LIMIT}.
   */
  limit?: number;
}

/**
 * Safe upper bound on items a single {@link paginate} run will yield by
 * default, so a runaway resource cannot stream unbounded into memory.
 */
export const DEFAULT_PAGINATION_LIMIT = 10_000;

/**
 * Generic async-iterator over a cursor-paginated resource (issue #14).
 *
 * Repeatedly calls `fetchPage`, yielding every record and following the
 * returned `nextCursor` until the resource is exhausted or `limit` items
 * have been produced. Retries, backoff, and error mapping are the
 * responsibility of `fetchPage` (the Horizon client wires its retrying
 * transport in underneath).
 *
 * @param fetchPage - Callback that retrieves a single page at a cursor.
 * @param options - Pagination bounds; see {@link PaginateOptions}.
 * @returns An async iterable of every record, in page order.
 *
 * @example
 * ```ts
 * for await (const tx of paginate((cursor) => fetchTxPage(cursor))) {
 *   process(tx);
 * }
 * ```
 */
export async function* paginate<T>(
  fetchPage: FetchPage<T>,
  options: PaginateOptions = {}
): AsyncIterable<T> {
  const limit = options.limit ?? DEFAULT_PAGINATION_LIMIT;
  if (!Number.isFinite(limit) || limit < 0) {
    throw new ValidationError("limit must be a non-negative finite number");
  }
  if (limit === 0) {
    return;
  }

  let cursor: string | undefined;
  let produced = 0;

  for (;;) {
    const page = await fetchPage(cursor);
    if (page.records.length === 0) {
      return; // Exhausted.
    }
    for (const record of page.records) {
      if (produced >= limit) {
        return; // Caller limit reached exactly.
      }
      yield record;
      produced += 1;
    }
    if (page.nextCursor === undefined || page.nextCursor === null) {
      return; // No further pages.
    }
    cursor = page.nextCursor;
  }
}

/**
 * Drains an async iterable into an array (issue #14).
 *
 * Convenience counterpart to {@link paginate} for callers that want the
 * whole (already bounded) collection in memory rather than streaming it.
 *
 * @param iterable - Any async iterable, e.g. the result of {@link paginate}.
 * @returns Every item produced by the iterable, in order.
 */
export async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iterable) {
    items.push(item);
  }
  return items;
}

/* ------------------------------------------------------------------ */
/* Client                                                              */
/* ------------------------------------------------------------------ */

/** Options for {@link HorizonRestClient}. */
export interface HorizonRestClientOptions {
  /** Base Horizon URL (no trailing slash required). */
  horizonUrl: string;
  /** Per-request timeout in milliseconds. Default: 10_000. */
  timeoutMs?: number;
  /** Maximum retry attempts for retriable failures. Default: 2 (= 1 initial + 2 retries). */
  maxRetries?: number;
  /** Base delay (ms) for exponential backoff when no Retry-After is given. Default: 250. */
  retryBackoffMs?: number;
  /** Dependency-injected fetch for tests/custom transports. Defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
}

/** Raw shape of Horizon's `/accounts/{id}` response (subset we consume).
 * Exported as `RawHorizonAccountFixture` so test fixtures can reuse the type. */
interface RawHorizonAccount {
  account_id: string;
  sequence: string;
  subentry_count: number;
  belly?: number;
  inflation_destination?: string;
  home_domain?: string;
  thresholds?: { low_threshold: number; med_threshold: number; high_threshold: number };
  last_updated_ledger: number;
  paging_token: string;
  flags?: { auth_required?: boolean; auth_immutable?: boolean; auth_clawback_enabled?: boolean };
  balances: Array<{
    asset_type: string;
    asset_code?: string;
    asset_issuer?: string;
    balance: string;
    is_authorized?: boolean;
    clawback_enabled?: boolean;
  }>;
  signers: Array<{ key: string; weight: number; type: string }>;
  data?: Record<string, string>;
}

/** Convert a 7-decimal Horizon amount string into a Number. */
function parseAmount(raw: string): number {
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Maps a raw Horizon account into the normalized {@link Account}. */
export function normalizeAccount(raw: RawHorizonAccount): Account {
  const balances: AccountBalance[] = (raw.balances ?? []).map((balance) => {
    const isNative = balance.asset_type === "native";
    return {
      code: isNative ? "XLM" : (balance.asset_code ?? ""),
      issuer: isNative ? undefined : balance.asset_issuer,
      type: balance.asset_type,
      amount: parseAmount(balance.balance),
      clawbackEnabled: balance.clawback_enabled === true,
      authorized: balance.is_authorized !== false,
    };
  });

  // Native balance first so feature code (e.g. "spendable XLM") can
  // deterministically read balances[0].
  balances.sort((a, b) => {
    const aRank = a.type === "native" ? 0 : 1;
    const bRank = b.type === "native" ? 0 : 1;
    if (aRank !== bRank) return aRank - bRank;
    return a.code < b.code ? -1 : a.code > b.code ? 1 : 0;
  });

  const signers: AccountSigner[] = (raw.signers ?? [])
    .map((signer) => ({
      key: signer.key,
      weight: signer.weight,
      type: signer.type,
    }))
    .sort((a, b) => b.weight - a.weight);

  return {
    id: raw.account_id,
    sequence: Number.parseInt(raw.sequence, 10),
    sequenceString: raw.sequence,
    signatureThreshold: raw.thresholds?.med_threshold ?? 0,
    subentryCount: raw.subentry_count ?? 0,
    thresholds: {
      low: raw.thresholds?.low_threshold ?? 0,
      medium: raw.thresholds?.med_threshold ?? 0,
      high: raw.thresholds?.high_threshold ?? 0,
    },
    balances,
    signers,
    inflationDestination: raw.inflation_destination,
    homeDomain: raw.home_domain,
    data: raw.data ?? {},
    lastLedger: raw.last_updated_ledger ?? 0,
    pagingToken: raw.paging_token,
  };
}

/**
 * Horizon REST client for account reads (issue #12).
 *
 * Uses the shared fetch wrapper with a per-request timeout, bounded
 * retries (#15) and taxonomy-conformant error mapping (#9).
 */
export class HorizonRestClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBackoffMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: HorizonRestClientOptions) {
    if (!options || typeof options.horizonUrl !== "string" || options.horizonUrl.length === 0) {
      throw new ValidationError("horizonUrl is required");
    }
    if (!/^(https?):\/\//i.test(options.horizonUrl)) {
      throw new ValidationError(
        `horizonUrl must be an absolute http(s) URL, got "${options.horizonUrl}"`
      );
    }
    this.baseUrl = options.horizonUrl.replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.maxRetries = options.maxRetries ?? 2;
    this.retryBackoffMs = options.retryBackoffMs ?? 250;
    this.fetchImpl = options.fetchImpl ?? ((...args) => globalThis.fetch(...args));
  }

  /* --- shared fetch wrapper with timeout + retry (#15) --- */

  /**
   * Performs a GET against Horizon with a hard timeout and bounded
   * retries for retriable failures.
   *
   * Retried: {@link NetworkError} (unreachable / aborted), HTTP 429 and
   * 5xx. Non-retriable failures (404, other 4xx) throw immediately.
   */
  private async getWithRetry(url: string, signal?: AbortSignal): Promise<Response> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        return await this.getOnce(url, signal);
      } catch (error) {
        if (!(error instanceof Error) || !("recoverable" in error)) {
          throw error; // Non-taxonomy failures are programming errors.
        }
        if (!(error as { recoverable?: boolean }).recoverable) {
          throw error; // e.g. NotFoundError — never retriable.
        }
        if (signal?.aborted) {
          throw error;
        }
        lastError = error;
        if (attempt < this.maxRetries) {
          await this.delay(this.retryDelayFor(error, attempt));
        }
      }
    }
    throw lastError;
  }

  /** Computes the wait before the next retry attempt. */
  private retryDelayFor(error: unknown, attempt: number): number {
    const retryAfterMs = (error as { retryAfterMs?: number }).retryAfterMs;
    if (typeof retryAfterMs === "number" && retryAfterMs > 0) {
      // Honor the server-provided Retry-After, but add jitter so a burst
      // of rate-limited callers does not retry in lockstep (#14).
      return retryAfterMs + this.jitter(retryAfterMs);
    }
    // Exponential backoff: base * 2^attempt, capped to avoid runaway waits.
    const backoff = Math.min(this.retryBackoffMs * 2 ** attempt, 4_000);
    return backoff + this.jitter(backoff);
  }

  /**
   * Returns a small random delay proportional to `base` so retries are
   * spread out instead of firing in lockstep (full-jitter style, #14).
   */
  private jitter(base: number): number {
    return Math.round(Math.random() * base * 0.1);
  }

  /** Aborts the in-flight request when the configured timeout elapses. */
  private async getOnce(url: string, outerSignal?: AbortSignal): Promise<Response> {
    const controller = new AbortController();
    // Propagate caller cancellation if one is supplied (unused today,
    // but keeps the wrapper reusable for streaming, #55).
    if (outerSignal) {
      outerSignal.addEventListener("abort", () => controller.abort(), { once: true });
    }
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "GET",
        headers: { accept: "application/json" },
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timer);
      if (controller.signal.aborted) {
        throw new NetworkError(
          `Horizon request timed out after ${this.timeoutMs}ms`,
          { cause: error }
        );
      }
      throw new NetworkError("Horizon could not be reached", { cause: error });
    }
    clearTimeout(timer);
    if (!response.ok) {
      throw this.toTaxonomyError(response);
    }
    return response;
  }

  /** Maps a failed Horizon HTTP response onto the taxonomy (#9). */
  private toTaxonomyError(response: Response): Error {
    const status = response.status;
    const retryAfterMs = this.parseRetryAfterMs(response);
    if (status === 404) {
      throw new NotFoundError(
        "Account not found on this network. It may not exist, or you may be querying the wrong network.",
        { recoverable: false }
      );
    }
    if (status === 429) {
      throw new RateLimitError(
        "Horizon rate limit reached; slow down and retry later.",
        { retryAfterMs }
      );
    }
    if (status >= 500) {
      throw new UpstreamError(`Horizon internal error (HTTP ${status})`, {
        upstreamStatus: status,
        recoverable: true,
        cause: { status },
      });
    }
    throw new UpstreamError(`Horizon rejected the request (HTTP ${status})`, {
      upstreamStatus: status,
      cause: { status },
    });
  }

  /** Reads `Retry-After` (seconds) into milliseconds when present. */
  private parseRetryAfterMs(response: Response): number | undefined {
    const raw = response.headers?.get?.("retry-after");
    if (raw == null || raw.length === 0) {
      return undefined;
    }
    const seconds = Number(raw);
    return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : undefined;
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /* --- Endpoints --- */

  /**
   * Fetches and normalizes a Stellar account from Horizon.
   *
   * @param address - Stellar account ID (G... format).
   * @returns The normalized {@link Account}.
   * @throws {ValidationError} If the address is invalid (checked locally, first).
   * @throws {NotFoundError} When the account does not exist on the network.
   * @throws {NetworkError} On timeout or unreachable Horizon.
   * @throws {RateLimitError} When Horizon asks the caller to slow down.
   * @throws {UpstreamError} For other HTTP failures.
   */
  async getAccount(address: string): Promise<Account> {
    validateAccountId(address);
    const response = await this.getWithRetry(`${this.baseUrl}/accounts/${address}`);
    const raw = (await response.json()) as RawHorizonAccount;
    if (raw?.account_id !== address) {
      throw new UpstreamError("Horizon returned an account that does not match the request", {
        upstreamStatus: response.status,
        cause: { requested: address, returned: raw?.account_id },
      });
    }
    return normalizeAccount(raw);
  }
}

/** Convenience factory: a client pointed at a network preset's Horizon. */
export function createHorizonRestClient(
  horizonUrl: string,
  options: Partial<HorizonRestClientOptions> = {}
): HorizonRestClient {
  return new HorizonRestClient({ ...options, horizonUrl });
}

/** @internal Compatibility alias so older option types still type-check. */
export type FraudDetectorErrorOptionsAlias = FraudDetectorErrorOptions;
/** Test-facing alias for the raw Horizon account shape (fixtures, #84). */
export type RawHorizonAccountFixture = RawHorizonAccount;
