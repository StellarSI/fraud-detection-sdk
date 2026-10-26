/**
 * Core fraud detection client.
 *
 * Main entry point for the SDK. Exposes `scoreAccount` and `watch`
 * as documented in the README quick-start.
 */

import { FraudDetectorOptions, HorizonClientLike, resolveConfig } from "./config.js";
import { ScoreResult } from "./types.js";
import { DEFAULT_THRESHOLDS } from "./scoring/levels.js";
import { aggregate } from "./scoring/aggregate.js";
import {
  ConfigError as TaxonomyConfigError,
  FraudDetectorError,
  NetworkError,
  NotFoundError,
  RateLimitError,
  UpstreamError,
  ValidationError,
} from "./errors.js";

/**
 * Horizon API response types.
 */
interface HorizonTransactionPage {
  _embedded: {
    records: Array<{
      id: string;
      created_at: string;
      source_account: string;
      type: string;
      amount: string;
      asset_code: string;
      to?: string;
      from?: string;
      memo?: string;
      memo_type?: string;
    }>;
  };
  _links: {
    next?: { href: string };
  };
}

/**
 * Minimal Horizon client interface for the detector.
 * Only the methods actually used by scoreAccount are declared here.
 */
export interface HorizonClient extends HorizonClientLike {
  getAccount(accountId: string): Promise<{
    id: string;
    sequence: string;
    thresholds: { low_threshold: number; med_threshold: number; high_threshold: number };
    balances: Array<{ asset_type: string; asset_code?: string; balance: string }>;
    signers: Array<{ weight: number; key: string; type: string }>;
    data: Record<string, string>;
    paging_token: string;
  }>;
  getAccountTransactions(accountId: string): Promise<
    Array<{
      id: string;
      created_at: string;
      source_account: string;
      type: string;
      amount: string;
      asset_code: string;
      to?: string;
      from?: string;
      memo?: string;
      memo_type?: string;
    }>
  >;
  getAccountTransactionsAsync(accountId: string): AsyncIterable<{
    id: string;
    created_at: string;
    source_account: string;
    type: string;
    amount: string;
    asset_code: string;
    to?: string;
    from?: string;
    memo?: string;
    memo_type?: string;
  }>;
}

/**
 * Default Horizon client implementation using the standard REST API.
 * Can be replaced with a custom client via constructor injection.
 */
export class DefaultHorizonClient implements HorizonClient {
  private readonly baseUrl: string;

  constructor(horizonUrl: string) {
    this.baseUrl = horizonUrl.replace(/\/+$/, "");
  }

  /**
   * Performs a GET against Horizon, translating transport and HTTP
   * failures into the shared SDK taxonomy (issue #9).
   */
  private async request(url: string): Promise<Response> {
    let response: Response;
    try {
      response = await fetch(url);
    } catch (error) {
      throw new NetworkError(
        "Could not reach Horizon. Check your internet connection and the configured Horizon URL, then try again.",
        { cause: error }
      );
    }
    if (!response.ok) {
      throw this.toTaxonomyError(response);
    }
    return response;
  }

  /** Maps a failed Horizon HTTP response to a taxonomy error. */
  private toTaxonomyError(response: Response): FraudDetectorError {
    const status = response.status;

    if (status === 404) {
      return new NotFoundError(
        "The requested account or resource could not be found. It may not exist on this network."
      );
    }

    if (status === 429) {
      return new RateLimitError(
        "Horizon is receiving too many requests. Please wait a moment and try again.",
        { retryAfterMs: this.parseRetryAfterMs(response) }
      );
    }

    if (status >= 500) {
      return new UpstreamError(
        "Horizon is having a temporary problem on its side. Please try again soon.",
        { upstreamStatus: status, recoverable: true }
      );
    }

    return new UpstreamError(
      `Horizon could not process this request (HTTP ${status} ${response.statusText}). Double-check the account ID and options, then try again.`,
      { upstreamStatus: status }
    );
  }

  /** Reads `Retry-After` (seconds) when the response exposes headers. */
  private parseRetryAfterMs(response: Response): number | undefined {
    const raw = (response.headers as { get?: (name: string) => string | null } | undefined)
      ?.get?.("retry-after");
    const seconds = raw === null ? Number.NaN : Number(raw);
    return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : undefined;
  }

  async getAccount(accountId: string) {
    const response = await this.request(`${this.baseUrl}/accounts/${accountId}`);
    return response.json() as Promise<{
      id: string;
      sequence: string;
      thresholds: { low_threshold: number; med_threshold: number; high_threshold: number };
      balances: Array<{ asset_type: string; asset_code?: string; balance: string }>;
      signers: Array<{ weight: number; key: string; type: string }>;
      data: Record<string, string>;
      paging_token: string;
    }>;
  }

  async *getAccountTransactionsAsync(accountId: string): AsyncIterable<{
    id: string;
    created_at: string;
    source_account: string;
    type: string;
    amount: string;
    asset_code: string;
    to?: string;
    from?: string;
    memo?: string;
    memo_type?: string;
  }> {
    let nextUrl: string | null = `${this.baseUrl}/accounts/${accountId}/transactions?limit=200&order=desc`;
    while (nextUrl) {
      const response = await this.request(nextUrl);
      const data = await response.json() as HorizonTransactionPage;
      for (const tx of data._embedded.records) {
        yield tx as {
          id: string;
          created_at: string;
          source_account: string;
          type: string;
          amount: string;
          asset_code: string;
          to?: string;
          from?: string;
          memo?: string;
          memo_type?: string;
        };
      }
      nextUrl = data._links?.next?.href ?? null;
    }
  }

  async getAccountTransactions(accountId: string): Promise<
    Array<{
      id: string;
      created_at: string;
      source_account: string;
      type: string;
      amount: string;
      asset_code: string;
      to?: string;
      from?: string;
      memo?: string;
      memo_type?: string;
    }>
  > {
    const transactions: Array<{
      id: string;
      created_at: string;
      source_account: string;
      type: string;
      amount: string;
      asset_code: string;
      to?: string;
      from?: string;
      memo?: string;
      memo_type?: string;
    }> = [];
    for await (const tx of this.getAccountTransactionsAsync(accountId)) {
      transactions.push(tx);
    }
    return transactions;
  }
}

/**
 * Error taxonomy for FraudDetector operations.
 *
 * The shared taxonomy lives in src/errors.ts (issue #9); the base class
 * and ValidationError are re-exported here so existing import sites
 * keep working, and Horizon-specific failures stay classified as
 * "HORIZON_ERROR".
 */
export { FraudDetectorError, ValidationError };

/**
 * Horizon-specific failure. Part of the SDK taxonomy, with the shared
 * base: it carries the stable "HORIZON_ERROR" code and is marked
 * recoverable because infrastructure hiccups resolve on retry.
 */
export class HorizonError extends FraudDetectorError {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, "HORIZON_ERROR", { ...options, recoverable: true });
    this.name = "HorizonError";
  }
}

/**
 * Config error specific to FraudDetector (wraps config.ConfigError
 * failures raised while resolving constructor options).
 */
export class DetectorConfigError extends TaxonomyConfigError {
  constructor(message: string) {
    super(message);
    this.name = "DetectorConfigError";
  }
}

/**
 * Main fraud detection client.
 *
 * Usage:
 * ```ts
 * const detector = new FraudDetector({ network: "testnet" });
 * const result = await detector.scoreAccount("GABC...XYZ");
 * ```
 */
export class FraudDetector {
  private readonly options: FraudDetectorOptions;
  private readonly horizon: HorizonClient;
  private readonly thresholds: { low: number; high: number };

  /**
   * Creates a new FraudDetector instance.
   *
   * @param options - Configuration options.
   * @throws {DetectorConfigError} If options are invalid.
   */
  constructor(options: FraudDetectorOptions) {
    this.options = resolveConfig(options);
    this.horizon = this.options.horizonClient
      ? (this.options.horizonClient as HorizonClient)
      : new DefaultHorizonClient(this.options.horizonUrl ?? "");
    this.thresholds = this.options.thresholds ?? DEFAULT_THRESHOLDS;
  }

  /**
   * Scores a Stellar account for fraud risk.
   *
   * Fetches account data and transaction history from Horizon,
   * runs feature extraction and detection, aggregates signals,
   * and returns a normalized score with explanation.
   *
   * @param accountId - Stellar account ID (G... format).
   * @returns Promise resolving to ScoreResult with score, level, and signals.
   * @throws {ValidationError} If accountId format is invalid.
   * @throws {HorizonError} If Horizon request fails (recoverable).
   */
  async scoreAccount(accountId: string): Promise<ScoreResult> {
    // Validate address before any network call
    this.validateAddress(accountId);

    try {
      // Fetch account and transactions in parallel
      const [account, transactions] = await Promise.all([
        this.horizon.getAccount(accountId),
        this.horizon.getAccountTransactions(accountId),
      ]);

      // Extract features
      const features = this.extractFeatures(account, transactions);

      // Run detectors (rules + statistical + ML); each declares its own
      // uniform signal weight (issue #8).
      const rawSignals = await this.runDetectors(features);

      // Combine the weighted detector outputs with the shared scoring
      // engine: sum, clip to [0, 1], classify the level, and emit the
      // deterministic ordered explanation.
      const contributions = rawSignals.map((signal) => ({
        id: signal.id,
        weight: signal.rawWeight,
        detail: signal.detail,
      }));
      const { score, level, signals } = aggregate(contributions, {
        thresholds: this.thresholds,
      });

      return {
        score,
        level,
        signals,
        baseline: this.computeBaseline(features),
      };
    } catch (error) {
      if (error instanceof FraudDetectorError) {
        throw error;
      }
      // Map unexpected errors to HorizonError, keeping the original
      // failure on `cause` for debugging (issue #9).
      throw new HorizonError(
        `Failed to score account: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      );
    }
  }

  /**
   * Streaming API for real-time monitoring (planned).
   *
   * ```ts
   * detector.watch({ assets: ["USDC:GA5Z..."] }, (alert) => { ... });
   * ```
   *
   * @throws {Error} Not yet implemented.
   */
  watch(): never {
    throw new Error("Streaming API not yet implemented (see roadmap)");
  }

  /**
   * Returns the resolved configuration (without injected client).
   */
  getConfig() {
    return {
      network: this.options.network,
      horizonUrl: this.options.horizonUrl,
      thresholds: this.thresholds,
    };
  }

  // --- Private methods ---

  /**
   * Validates a Stellar account ID (G... format).
   * Runs before any network I/O.
   */
  private validateAddress(accountId: string): void {
    if (!accountId || typeof accountId !== "string") {
      throw new ValidationError("Account ID is required and must be a string");
    }
    if (!/^G[A-Z0-9]{55}$/.test(accountId)) {
      throw new ValidationError(
        `Invalid Stellar account ID: "${accountId}". Must be 56 characters starting with 'G'.`
      );
    }
  }

  /**
   * Extracts features from account and transaction data.
   *
   * Feature extraction is still a placeholder for the richer velocity /
   * graph / asset detectors (issues #5+), but the social-graph features
   * that detectors already consume (unique counterparties, fan-out
   * ratio, asset diversity, trustlines) are computed for real so the
   * aggregation engine receives meaningful declared weights.
   */
  private extractFeatures(account: unknown, transactions: unknown[]): FeatureVector {
    const txs = Array.isArray(transactions) ? transactions : [];

    const counterparties = new Set<string>();
    const outgoing = new Set<string>();
    for (const tx of txs) {
      const t = tx as { to?: unknown; from?: unknown } | null | undefined;
      if (t && typeof t.to === "string" && t.to) {
        outgoing.add(t.to);
        counterparties.add(t.to);
      }
      if (t && typeof t.from === "string" && t.from) {
        counterparties.add(t.from);
      }
    }

    const acct = account as { balances?: Array<{ asset_code?: string; asset_type?: string }> } | null;
    const assetSet = new Set<string>();
    for (const balance of acct?.balances ?? []) {
      assetSet.add(balance.asset_code ?? balance.asset_type ?? "native");
    }

    return {
      accountAge: 0,
      transactionCount: txs.length,
      uniqueCounterparties: counterparties.size,
      assetDiversity: assetSet.size,
      velocityScore: 0,
      fanOutRatio: txs.length > 0 ? outgoing.size / txs.length : 0,
      trustlineCount: acct?.balances?.length ?? 0,
    };
  }

  /**
   * Runs all configured detectors against the feature vector.
   */
  private async runDetectors(features: FeatureVector): Promise<RawSignal[]> {
    const signals: RawSignal[] = [];

    // Rule-based detectors
    signals.push(...this.runRuleDetectors(features));

    // Statistical detectors
    signals.push(...this.runStatisticalDetectors(features));

    // ML detectors (placeholder)
    // signals.push(...await this.runMLDetectors(features));

    return signals;
  }

  /**
   * Runs rule-based detectors (fast, deterministic).
   */
  private runRuleDetectors(features: FeatureVector): RawSignal[] {
    const signals: RawSignal[] = [];

    // Example: rapid fan-out detection
    if (features.fanOutRatio > 0.8) {
      signals.push({
        id: "rapid-fan-out",
        rawWeight: 0.6,
        detail: "Account sends to many counterparties in short time",
      });
    }

    // Example: high velocity
    if (features.velocityScore > 0.7) {
      signals.push({
        id: "high-velocity",
        rawWeight: 0.5,
        detail: "Unusually high transaction frequency",
      });
    }

    // Example: fresh account
    if (features.accountAge < 86400) { // < 24 hours
      signals.push({
        id: "fresh-account",
        rawWeight: 0.3,
        detail: "Account created less than 24 hours ago",
      });
    }

    return signals;
  }

  /**
   * Runs statistical detectors (baseline deviation).
   */
  private runStatisticalDetectors(features: FeatureVector): RawSignal[] {
    const signals: RawSignal[] = [];

    // Example: transaction count anomaly
    if (features.transactionCount > 1000) {
      signals.push({
        id: "high-tx-count",
        rawWeight: Math.min(features.transactionCount / 5000, 1),
        detail: "Transaction count significantly above baseline",
      });
    }

    return signals;
  }

  /**
   * Computes a baseline identifier for the score.
   */
  private computeBaseline(features: FeatureVector): string {
    // Placeholder: real implementation would hash feature vector
    // or look up a baseline from the behavioral model
    return `baseline:v1:${features.transactionCount}:${features.uniqueCounterparties}`;
  }
}

// --- Internal types ---

interface FeatureVector {
  accountAge: number;
  transactionCount: number;
  uniqueCounterparties: number;
  assetDiversity: number;
  velocityScore: number;
  fanOutRatio: number;
  trustlineCount: number;
}

interface RawSignal {
  id: string;
  rawWeight: number;
  detail?: string;
}