/**
 * Transaction-analytics-api client adapter (issue #16).
 *
 * Implements the {@link DataSource} interface backed by the sibling
 * `transaction-analytics-api` service, so the FraudDetector can consume
 * either Horizon or transaction-analytics-api interchangeably.
 *
 * Normalizes account-insights and flow-stream responses into the same
 * {@link Account} / {@link Transaction} shapes the Horizon client
 * produces (#12, #13), and maps upstream errors onto the shared SDK
 * taxonomy (#9).
 */

import {
  Account,
  AccountBalance,
  AccountSigner,
  Transaction,
  type Page,
  type FetchPage,
} from "./horizon.js";
import {
  FraudDetectorError,
  NetworkError,
  NotFoundError,
  RateLimitError,
  UpstreamError,
  ValidationError,
} from "../errors.js";

/** Raw shape of transaction-analytics-api account insights (subset). */
interface RawTransactionAnalyticsAccount {
  account_id: string;
  sequence: string;
  subentry_count: number;
  thresholds?: { low_threshold: number; med_threshold: number; high_threshold: number };
  last_updated_ledger: number;
  paging_token: string;
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

/** Raw shape of transaction-analytics-api flow records (subset). */
interface RawTransactionAnalyticsFlow {
  id: string;
  created_at?: string;
  source_account?: string;
  type?: string;
  amount?: string;
  asset_code?: string;
  asset_issuer?: string;
  from?: string;
  to?: string;
  memo?: string;
  memo_type?: string;
  successful?: boolean;
  ledger?: number;
  paging_token?: string;
}

/** Raw envelope for a transaction-analytics-api collection. */
interface RawTransactionAnalyticsCollection {
  records?: RawTransactionAnalyticsFlow[];
  next_cursor?: string;
}

/** Options for {@link TransactionAnalyticsClient}. */
export interface TransactionAnalyticsClientOptions {
  /** Base transaction-analytics-api URL (no trailing slash required). */
  apiUrl: string;
  /** Per-request timeout in milliseconds. Default: 10_000. */
  timeoutMs?: number;
  /** Maximum retry attempts for retriable failures. Default: 2. */
  maxRetries?: number;
  /** Base delay (ms) for exponential backoff. Default: 250. */
  retryBackoffMs?: number;
  /** Dependency-injected fetch for tests/custom transports. */
  fetchImpl?: typeof fetch;
}

/**
 * Common data-source interface (issue #16).
 *
 * The FraudDetector can consume any implementation of this interface,
 * whether backed by Horizon or transaction-analytics-api. This keeps
 * feature code decoupled from the upstream wire format.
 */
export interface DataSource {
  /** Fetches and normalizes a Stellar account. */
  getAccount(address: string): Promise<Account>;
  /** Streams an account's transactions. */
  getTransactions(
    address: string,
    options?: GetTransactionsOptions
  ): Promise<Transaction[]>;
}

/** Options for {@link DataSource.getTransactions} (issue #13). */
export interface GetTransactionsOptions {
  /** Maximum total transactions to return. */
  limit?: number;
  /** Start paging from this cursor (paging token). */
  cursor?: string;
  /** Paging order: "asc" or "desc". */
  order?: "asc" | "desc";
  /** Per-request page size sent to the API (1-200). */
  pageSize?: number;
  /** Only include transactions at or after this ISO-8601 time. */
  startTime?: string;
  /** Only include transactions at or before this ISO-8601 time. */
  endTime?: string;
}

/** The transaction-analytics-api caps a single page at 200 records. */
const MAX_PAGE_SIZE = 200;

function clampPageSize(pageSize: number | undefined): number {
  if (pageSize === undefined || !Number.isFinite(pageSize)) {
    return MAX_PAGE_SIZE;
  }
  return Math.min(Math.max(Math.trunc(pageSize), 1), MAX_PAGE_SIZE);
}

/** Converts a 7-decimal amount string into a Number. */
function parseAmount(raw: string): number {
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Maps a raw transaction-analytics-api account into the normalized {@link Account}. */
export function normalizeTransactionAnalyticsAccount(raw: RawTransactionAnalyticsAccount): Account {
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
    inflationDestination: undefined,
    homeDomain: undefined,
    data: raw.data ?? {},
    lastLedger: raw.last_updated_ledger ?? 0,
    pagingToken: raw.paging_token,
  };
}

/** Maps a raw transaction-analytics-api flow into the normalized {@link Transaction}. */
export function normalizeTransactionAnalyticsFlow(raw: RawTransactionAnalyticsFlow): Transaction {
  const isNative = raw.asset_code === undefined;
  return {
    id: raw.id,
    createdAt: raw.created_at ?? "",
    sourceAccount: raw.source_account ?? "",
    type: raw.type ?? "",
    amount: parseAmount(raw.amount ?? "0"),
    assetCode: isNative ? "XLM" : raw.asset_code,
    assetIssuer: raw.asset_issuer,
    from: raw.from,
    to: raw.to,
    memo: raw.memo,
    memoType: raw.memo_type,
    successful: raw.successful,
    ledger: raw.ledger,
    pagingToken: raw.paging_token ?? "",
  };
}

/**
 * Maps a failed transaction-analytics-api HTTP response onto the SDK
 * taxonomy (#9).
 */
function toTaxonomyError(response: Response): Error {
  const status = response.status;
  const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));

  if (status === 404) {
    throw new NotFoundError(
      "Account not found on transaction-analytics-api.",
      { recoverable: false }
    );
  }
  if (status === 429) {
    throw new RateLimitError(
      "transaction-analytics-api rate limit reached; slow down and retry later.",
      { retryAfterMs }
    );
  }
  if (status >= 500) {
    throw new UpstreamError(`transaction-analytics-api internal error (HTTP ${status})`, {
      upstreamStatus: status,
      recoverable: true,
      cause: { status },
    });
  }
  throw new UpstreamError(`transaction-analytics-api rejected the request (HTTP ${status})`, {
    upstreamStatus: status,
    cause: { status },
  });
}

/** Reads `Retry-After` (seconds) into milliseconds when present. */
function parseRetryAfterMs(value: string | null): number | undefined {
  if (value == null || value.length === 0) return undefined;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : undefined;
}

/**
 * Validates a Stellar account ID (G... format) before any network call.
 */
export function validateAccountId(address: string): void {
  if (typeof address !== "string" || address.length === 0) {
    throw new ValidationError("Stellar account ID is required");
  }
  if (address.length !== 56) {
    throw new ValidationError(
      `Stellar account ID must be exactly 56 characters, got ${address.length}`
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
}

/**
 * transaction-analytics-api client implementing {@link DataSource} (issue #16).
 *
 * Uses a shared fetch wrapper with per-request timeout, bounded retries
 * (#15), and taxonomy-conformant error mapping (#9).
 */
export class TransactionAnalyticsClient implements DataSource {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBackoffMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: TransactionAnalyticsClientOptions) {
    if (!options || typeof options.apiUrl !== "string" || options.apiUrl.length === 0) {
      throw new ValidationError("apiUrl is required");
    }
    if (!/^(https?):\/\//i.test(options.apiUrl)) {
      throw new ValidationError(
        `apiUrl must be an absolute http(s) URL, got "${options.apiUrl}"`
      );
    }
    this.baseUrl = options.apiUrl.replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.maxRetries = options.maxRetries ?? 2;
    this.retryBackoffMs = options.retryBackoffMs ?? 250;
    this.fetchImpl = options.fetchImpl ?? ((...args) => globalThis.fetch(...args));
  }

  /** Performs a GET against transaction-analytics-api with timeout and retries. */
  private async getWithRetry(url: string): Promise<Response> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        return await this.getOnce(url);
      } catch (error) {
        if (!(error instanceof Error) || !("recoverable" in error)) {
          throw error;
        }
        if (!(error as { recoverable?: boolean }).recoverable) {
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

  private retryDelayFor(error: unknown, attempt: number): number {
    const retryAfterMs = (error as { retryAfterMs?: number }).retryAfterMs;
    if (typeof retryAfterMs === "number" && retryAfterMs > 0) {
      return retryAfterMs + this.jitter(retryAfterMs);
    }
    const backoff = Math.min(this.retryBackoffMs * 2 ** attempt, 4_000);
    return backoff + this.jitter(backoff);
  }

  private jitter(base: number): number {
    return Math.round(Math.random() * base * 0.1);
  }

  private async getOnce(url: string): Promise<Response> {
    const controller = new AbortController();
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
          `transaction-analytics-api request timed out after ${this.timeoutMs}ms`,
          { cause: error }
        );
      }
      throw new NetworkError("transaction-analytics-api could not be reached", { cause: error });
    }
    clearTimeout(timer);
    if (!response.ok) {
      throw toTaxonomyError(response);
    }
    return response;
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** {@inheritDoc DataSource.getAccount} */
  async getAccount(address: string): Promise<Account> {
    validateAccountId(address);
    const response = await this.getWithRetry(`${this.baseUrl}/accounts/${address}`);
    const raw = (await response.json()) as RawTransactionAnalyticsAccount;
    return normalizeTransactionAnalyticsAccount(raw);
  }

  /** {@inheritDoc DataSource.getTransactions} */
  async getTransactions(
    address: string,
    options: GetTransactionsOptions = {}
  ): Promise<Transaction[]> {
    validateAccountId(address);
    if (options.order !== undefined && options.order !== "asc" && options.order !== "desc") {
      throw new ValidationError(`order must be "asc" or "desc", got "${options.order}"`);
    }

    const records = await this.paginateTransactions(address, options);
    return records;
  }

  private async paginateTransactions(
    address: string,
    options: GetTransactionsOptions
  ): Promise<Transaction[]> {
    const results: Transaction[] = [];
    let cursor = options.cursor;
    let produced = 0;
    const limit = options.limit ?? 10_000;

    for (;;) {
      const page = await this.fetchPage(address, cursor, options);
      if (page.records.length === 0) return results;
      for (const record of page.records) {
        if (produced >= limit) return results;
        results.push(record);
        produced += 1;
      }
      if (page.nextCursor === undefined || page.nextCursor === null) return results;
      cursor = page.nextCursor;
    }
  }

  private async fetchPage(
    address: string,
    cursor: string | undefined,
    options: GetTransactionsOptions
  ): Promise<Page<Transaction>> {
    const params = new URLSearchParams();
    params.set("limit", String(clampPageSize(options.pageSize)));
    params.set("order", options.order ?? "desc");
    if (cursor) params.set("cursor", cursor);
    if (options.startTime) params.set("start_time", options.startTime);
    if (options.endTime) params.set("end_time", options.endTime);

    const url = `${this.baseUrl}/accounts/${address}/flows?${params.toString()}`;
    const response = await this.getWithRetry(url);
    const body = (await response.json()) as RawTransactionAnalyticsCollection;
    const records = (body.records ?? []).map(normalizeTransactionAnalyticsFlow);
    return {
      records,
      nextCursor: body.next_cursor,
    };
  }
}

/** Convenience factory: a client pointed at a transaction-analytics-api base URL. */
export function createTransactionAnalyticsClient(
  apiUrl: string,
  options: Partial<TransactionAnalyticsClientOptions> = {}
): TransactionAnalyticsClient {
  return new TransactionAnalyticsClient({ ...options, apiUrl });
}

export type { Page, FetchPage } from "./horizon.js";