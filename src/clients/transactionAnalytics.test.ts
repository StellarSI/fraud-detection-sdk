/**
 * Tests for the transaction-analytics-api client adapter (issue #16).
 *
 * All tests run fully offline against a fake `fetch`. No network access.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  TransactionAnalyticsClient,
  normalizeTransactionAnalyticsAccount,
  normalizeTransactionAnalyticsFlow,
  validateAccountId,
  type DataSource,
  type TransactionAnalyticsClientOptions,
} from "./transactionAnalytics.js";
import {
  NetworkError,
  NotFoundError,
  RateLimitError,
  UpstreamError,
  ValidationError,
} from "../errors.js";
import { Account, Transaction } from "./horizon.js";

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function clientFor(fetchImpl: ReturnType<typeof vi.fn>, options = {}): TransactionAnalyticsClient {
  return new TransactionAnalyticsClient({
    apiUrl: "https://ta.example.org",
    fetchImpl: fetchImpl as unknown as typeof fetch,
    retryBackoffMs: 1,
    ...options,
  });
}

const ADDRESS = "GABCDEFGHIJKLMNOPQRSTUVWXYZABCDEFGHIJKLMNOPQRSTUVWXYZABCDEF";

const accountFixture = {
  account_id: ADDRESS,
  sequence: "1234567890",
  subentry_count: 3,
  thresholds: { low_threshold: 1, med_threshold: 5, high_threshold: 10 },
  last_updated_ledger: 42,
  paging_token: "42",
  balances: [
    { asset_type: "native", balance: "100.0000000" },
    {
      asset_type: "credit_alphanum4",
      asset_code: "USD",
      asset_issuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHPM6V4TGSBRPT24OMZPMFASOMSDWOR",
      balance: "12.3400000",
      is_authorized: true,
      clawback_enabled: false,
    },
  ],
  signers: [
    { key: ADDRESS, weight: 10, type: "ed25519_public_key" },
    { key: "GBXYZABCDEFGHIJKLMNOPQRSTUVWXYZABCDEFGHIJKLMNOPQ", weight: 2, type: "ed25519_public_key" },
  ],
  data: { memo: "hello" },
};

const flowFixture = {
  id: "tx1",
  created_at: "2024-01-15T10:00:00Z",
  source_account: ADDRESS,
  type: "payment",
  amount: "100.0000000",
  asset_code: "USDC",
  to: "GOTHER...123",
  successful: true,
  ledger: 100,
  paging_token: "100",
};

describe("normalizeTransactionAnalyticsAccount", () => {
  it("normalizes native balance first", () => {
    const account = normalizeTransactionAnalyticsAccount(accountFixture);
    expect(account.balances[0]).toMatchObject({ code: "XLM", amount: 100 });
    expect(account.balances[1]).toMatchObject({ code: "USD", amount: 12.34 });
  });

  it("maps all fields", () => {
    const account = normalizeTransactionAnalyticsAccount(accountFixture);
    expect(account.id).toBe(ADDRESS);
    expect(account.sequence).toBe(1234567890);
    expect(account.signers.map((s) => s.weight)).toEqual([10, 2]);
    expect(account.data).toEqual({ memo: "hello" });
    expect(account.lastLedger).toBe(42);
    expect(account.pagingToken).toBe("42");
  });
});

describe("normalizeTransactionAnalyticsFlow", () => {
  it("normalizes a flow record", () => {
    const tx = normalizeTransactionAnalyticsFlow(flowFixture);
    expect(tx.id).toBe("tx1");
    expect(tx.sourceAccount).toBe(ADDRESS);
    expect(tx.amount).toBe(100);
    expect(tx.assetCode).toBe("USDC");
    expect(tx.to).toBe("GOTHER...123");
    expect(tx.successful).toBe(true);
    expect(tx.ledger).toBe(100);
  });

  it("defaults asset code to XLM for native", () => {
    const tx = normalizeTransactionAnalyticsFlow({ ...flowFixture, asset_code: undefined });
    expect(tx.assetCode).toBe("XLM");
  });
});

describe("validateAccountId", () => {
  it("accepts valid G... addresses", () => {
    expect(() => validateAccountId(ADDRESS)).not.toThrow();
  });

  it("rejects empty / wrong-length input", () => {
    expect(() => validateAccountId("")).toThrow(ValidationError);
    expect(() => validateAccountId("GABC")).toThrow(ValidationError);
    expect(() => validateAccountId("X".repeat(56))).toThrow(ValidationError);
  });

  it("rejects non-G prefix", () => {
    expect(() => validateAccountId("C".repeat(56))).toThrow(ValidationError);
  });
});

describe("TransactionAnalyticsClient.getAccount", () => {
  it("returns a normalized account", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(accountFixture));
    const account = await clientFor(fetchImpl).getAccount(ADDRESS);
    expect(account.id).toBe(ADDRESS);
    expect(account.balances[0]).toMatchObject({ code: "XLM", amount: 100 });
  });

  it("maps 404 to NotFoundError", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ status: 404 }, 404));
    await expect(clientFor(fetchImpl).getAccount(ADDRESS)).rejects.toBeInstanceOf(NotFoundError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("maps 429 to RateLimitError", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({}, 429, { "retry-after": "1" })
    );
    await expect(clientFor(fetchImpl, { maxRetries: 0 }).getAccount(ADDRESS)).rejects.toBeInstanceOf(
      RateLimitError
    );
  });

  it("wraps network errors in NetworkError", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError("network down"));
    await expect(clientFor(fetchImpl).getAccount(ADDRESS)).rejects.toBeInstanceOf(NetworkError);
  });

  it("retries 5xx and succeeds on later attempt", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({}, 500))
      .mockResolvedValueOnce(jsonResponse(accountFixture));
    const client = clientFor(fetchImpl, { retryBackoffMs: 1 });
    const account = await client.getAccount(ADDRESS);
    expect(account.id).toBe(ADDRESS);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe("TransactionAnalyticsClient.getTransactions", () => {
  it("returns normalized transactions", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ records: [flowFixture], next_cursor: null })
    );
    const txs = await clientFor(fetchImpl).getTransactions(ADDRESS);
    expect(txs).toHaveLength(1);
    expect(txs[0].id).toBe("tx1");
  });

  it("validates order option", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ records: [], next_cursor: null }));
    await expect(
      clientFor(fetchImpl).getTransactions(ADDRESS, { order: "invalid" as any })
    ).rejects.toThrow(ValidationError);
  });

  it("supports pagination", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ records: [flowFixture], next_cursor: "cursor2" })
      )
      .mockResolvedValueOnce(jsonResponse({ records: [], next_cursor: null }));
    const txs = await clientFor(fetchImpl).getTransactions(ADDRESS);
    expect(txs).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe("DataSource interface", () => {
  it("TransactionAnalyticsClient implements DataSource", () => {
    const client = clientFor(vi.fn().mockResolvedValue(jsonResponse(accountFixture)));
    const source: DataSource = client;
    expect(typeof source.getAccount).toBe("function");
    expect(typeof source.getTransactions).toBe("function");
  });

  it("DataSource type is satisfied by the client", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(accountFixture));
    const source: DataSource = clientFor(fetchImpl);
    const account = await source.getAccount(ADDRESS);
    expect(account.id).toBe(ADDRESS);
  });
});
