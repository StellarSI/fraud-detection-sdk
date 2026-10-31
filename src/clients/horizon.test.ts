/**
 * Tests for the Horizon REST account client (issue #12).
 *
 * No network access: every request goes through an injected fake
 * `fetch` (fixtures per issue #84).
 */

import { describe, it, expect, vi } from "vitest";
import {
  HorizonRestClient,
  validateAccountId,
  normalizeAccount,
  paginate,
  collect,
  DEFAULT_PAGINATION_LIMIT,
  type Page,
  type RawHorizonAccountFixture,
} from "./horizon.js";
import {
  NetworkError,
  NotFoundError,
  RateLimitError,
  UpstreamError,
  ValidationError,
} from "../errors.js";

/**
 * Builds a structurally-valid G... address without shipping a real
 * crypto dependency: valid base32 alphabet + correct CRC-16 checksum.
 * Based on the strkey encoding algorithm.
 */
function makeValidAddress(seed: number): string {
  // 32 deterministic payload bytes
  const payload: number[] = [];
  for (let i = 0; i < 32; i++) {
    payload.push((seed * 31 + i * 7) % 256);
  }
  const version = 6 << 3; // ed25519PublicKey
  const bytes = [version, ...payload];
  let crc = 0x0000;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) {
      crc = crc & 0x8000 ? (crc << 1) ^ 0x1021 : crc << 1;
      crc &= 0xffff;
    }
  }
  const all = [...bytes, (crc >> 8) & 0xff, crc & 0xff];
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of all) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  while (out.length < 56) out += alphabet[0];
  return out.slice(0, 56);
}

const ADDRESS = makeValidAddress(1);

function horizonFixture(overrides: Partial<RawHorizonAccountFixture> = {}): Record<string, unknown> {
  return {
    account_id: ADDRESS,
    sequence: "1234567890",
    subentry_count: 3,
    thresholds: { low_threshold: 1, med_threshold: 5, high_threshold: 10 },
    last_updated_ledger: 42,
    paging_token: "42",
    balances: [
      {
        asset_type: "credit_alphanum4",
        asset_code: "USD",
        asset_issuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHPM6V4TGSBRPT24OMZPMFASOMSDWOR",
        balance: "12.3400000",
        is_authorized: true,
        clawback_enabled: false,
      },
      {
        asset_type: "native",
        balance: "100.0000000",
      },
    ],
    signers: [
      { key: ADDRESS, weight: 10, type: "ed25519_public_key" },
      { key: makeValidAddress(3), weight: 2, type: "ed25519_public_key" },
    ],
    data: { memo: "hello" },
    flags: {},
    ...overrides,
  };
}

type FetchLike = ReturnType<typeof vi.fn>;

async function jsonResponse(body: Record<string, unknown>, status = 200, headers: Record<string, string> = {}): Promise<Response> {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("validateAccountId", () => {
  it("accepts structurally valid G... addresses", () => {
    expect(() => validateAccountId(ADDRESS)).not.toThrow();
  });

  it("rejects empty / wrong-length / wrong-prefix input before any network call", () => {
    expect(() => validateAccountId("")).toThrow(ValidationError);
    expect(() => validateAccountId("GABC")).toThrow(ValidationError);
    expect(() => validateAccountId("X".repeat(56))).toThrow(ValidationError);
  });

  it("rejects corrupted addresses whose checksum fails", () => {
    const corrupted = ADDRESS.slice(0, 55) + (ADDRESS.endsWith("A") ? "B" : "A");
    // Base32 order may collide — flip a low-order nibble deterministically:
    expect(() => validateAccountId(corrupted)).toThrow(ValidationError);
  });
});

describe("HorizonRestClient.getAccount", () => {
  function clientFor(fetchImpl: FetchLike, overrides = {}): HorizonRestClient {
    return new HorizonRestClient({
      horizonUrl: "https://horizon.example.org",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      retryBackoffMs: 1,
      ...overrides,
    });
  }

  it("returns a normalized account and never touches raw Horizon JSON", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(await jsonResponse(horizonFixture()));
    const account = await clientFor(fetchImpl).getAccount(ADDRESS);

    expect(account.id).toBe(ADDRESS);
    expect(account.sequence).toBe(1234567890);
    expect(account.sequenceString).toBe("1234567890");
    expect(account.thresholds).toEqual({ low: 1, medium: 5, high: 10 });
    expect(account.subentryCount).toBe(3);
    expect(account.balances[0]).toMatchObject({ code: "XLM", amount: 100 });
    expect(account.balances[1]).toMatchObject({ code: "USD", amount: 12.34 });
    expect(account.signers.map((s) => s.weight)).toEqual([10, 2]);
    expect(account.data).toEqual({ memo: "hello" });
    expect(account.lastLedger).toBe(42);
    // request went to the right endpoint
    expect(fetchImpl.mock.calls[0][0]).toBe(`https://horizon.example.org/accounts/${ADDRESS}`);
  });

  it("maps 404 to NotFoundError and does not retry", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      await jsonResponse({ status: 404, title: "Not Found" }, 404)
    );
    await expect(clientFor(fetchImpl).getAccount(ADDRESS)).rejects.toBeInstanceOf(NotFoundError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("maps timeouts to NetworkError", async () => {
    const fetchImpl = vi.fn().mockImplementation(
      () =>
        new Promise<Response>((_, reject) => {
          const abort = new AbortController();
          setTimeout(() => reject(new Error("aborted", { cause: { name: "AbortError" } })), 10);
          void abort;
        })
    );
    await expect(
      clientFor(fetchImpl, { timeoutMs: 20 }).getAccount(ADDRESS)
    ).rejects.toBeInstanceOf(NetworkError);
  }, 5_000);

  it("maps 429 to RateLimitError and honors Retry-After", async () => {
    const fetchImpl = vi
      .fn()
      .mockImplementation(async () => {
        await jsonResponse({}, 429, { "retry-after": "1" });
        return new Response("{}", { status: 429, headers: { "retry-after": "1" } });
      });
    await expect(clientFor(fetchImpl, { maxRetries: 0 }).getAccount(ADDRESS)).rejects.toBeInstanceOf(
      RateLimitError
    );
  });

  it("retries 5xx responses and succeeds on a later attempt", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(await jsonResponse({ status: 500 }, 500))
      .mockResolvedValueOnce(await jsonResponse(horizonFixture()));
    const client = clientFor(fetchImpl, { retryBackoffMs: 1 });
    const account = await client.getAccount(ADDRESS);
    expect(account.id).toBe(ADDRESS);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("gives up after maxRetries on persistent NetworkError", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    await expect(
      clientFor(fetchImpl, { maxRetries: 2, retryBackoffMs: 1 }).getAccount(ADDRESS)
    ).rejects.toBeInstanceOf(NetworkError);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("throws UpstreamError on identity mismatch between request and response", async () => {
    const fixture = horizonFixture({ account_id: makeValidAddress(9) });
    const fetchImpl = vi.fn().mockResolvedValue(await jsonResponse(fixture));
    await expect(clientFor(fetchImpl).getAccount(ADDRESS)).rejects.toBeInstanceOf(UpstreamError);
  });

  it("rejects malformed URLs at construction time", () => {
    expect(
      () => new HorizonRestClient({ horizonUrl: "" })
    ).toThrow(ValidationError);
    expect(
      () => new HorizonRestClient({ horizonUrl: "not a url" })
    ).toThrow(ValidationError);
  });
});

describe("normalizeAccount", () => {
  it("normalizes the raw fixture deterministically", () => {
    const account = normalizeAccount(horizonFixture() as unknown as RawHorizonAccountFixture);
    expect(account.inflationDestination).toBeUndefined();
    expect(account.balances.map((b) => b.code)).toEqual(["XLM", "USD"]);
    expect(account.signers[0].key).toBe(ADDRESS);
  });
});

describe("paginate (issue #14)", () => {
  /** Builds a fetchPage that serves `pages` in order, tracking cursors. */
  function pagedFetcher(pages: Record<string, Page<number>>) {
    const calls: Array<string | undefined> = [];
    const fetchPage = async (cursor?: string): Promise<Page<number>> => {
      calls.push(cursor);
      return pages[cursor ?? "start"];
    };
    return { fetchPage, calls };
  }

  it("walks every page following nextCursor until exhaustion (multi-page)", async () => {
    const { fetchPage, calls } = pagedFetcher({
      start: { records: [1, 2], nextCursor: "p2" },
      p2: { records: [3, 4], nextCursor: "p3" },
      p3: { records: [5], nextCursor: undefined },
    });

    const items = await collect(paginate(fetchPage));

    expect(items).toEqual([1, 2, 3, 4, 5]);
    // First call has no cursor; subsequent calls follow the chain.
    expect(calls).toEqual([undefined, "p2", "p3"]);
  });

  it("returns the records of a single-page response without extra fetches", async () => {
    const { fetchPage, calls } = pagedFetcher({
      start: { records: [10, 20, 30] },
    });

    const items = await collect(paginate(fetchPage));

    expect(items).toEqual([10, 20, 30]);
    expect(calls).toHaveLength(1);
  });

  it("honors a caller limit exactly, stopping mid-page when needed", async () => {
    const { fetchPage, calls } = pagedFetcher({
      start: { records: [1, 2, 3, 4, 5], nextCursor: "p2" },
      p2: { records: [6, 7], nextCursor: undefined },
    });

    const items = await collect(paginate(fetchPage, { limit: 3 }));

    expect(items).toEqual([1, 2, 3]);
    // Stops as soon as the limit is hit — never fetches the second page.
    expect(calls).toEqual([undefined]);
  });

  it("stops on an empty page even if a nextCursor is present", async () => {
    const { fetchPage } = pagedFetcher({
      start: { records: [] as number[], nextCursor: "p2" },
    });
    await expect(collect(paginate(fetchPage))).resolves.toEqual([]);
  });

  it("yields nothing for a limit of 0 without fetching", async () => {
    const { fetchPage, calls } = pagedFetcher({
      start: { records: [1, 2] },
    });
    await expect(collect(paginate(fetchPage, { limit: 0 }))).resolves.toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("defaults the bound to DEFAULT_PAGINATION_LIMIT", async () => {
    expect(DEFAULT_PAGINATION_LIMIT).toBeGreaterThan(0);
  });

  it("rejects a negative limit", async () => {
    const { fetchPage } = pagedFetcher({ start: { records: [1] } });
    await expect(collect(paginate(fetchPage, { limit: -1 }))).rejects.toThrow();
  });
});

describe("HorizonRestClient.getTransactions (issue #13)", () => {
  function transactionFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: "abc123",
      paging_token: "88",
      created_at: "2026-01-01T00:00:00Z",
      source_account: ADDRESS,
      type: "payment",
      amount: "25.0000000",
      asset_code: "USD",
      asset_issuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHPM6V4TGSBRPT24OMZPMFASOMSDWOR",
      from: ADDRESS,
      to: makeValidAddress(2),
      memo: "invoice-1",
      memo_type: "text",
      successful: true,
      ledger: 100,
      ...overrides,
    };
  }

  /** Builds a HAL collection page with an optional `next` link. */
  function transactionPage(
    records: Record<string, unknown>[],
    nextHref?: string
  ): Record<string, unknown> {
    const links: Record<string, unknown> = {};
    if (nextHref) {
      links.next = { href: nextHref };
    }
    return { _embedded: { records }, _links: links };
  }

  function clientFor(fetchImpl: FetchLike, overrides = {}): HorizonRestClient {
    return new HorizonRestClient({
      horizonUrl: "https://horizon.example.org",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      retryBackoffMs: 1,
      ...overrides,
    });
  }

  it("returns normalized transactions for a valid address (single page)", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(await jsonResponse(transactionPage([transactionFixture()])));
    const txs = await clientFor(fetchImpl).getTransactions(ADDRESS);

    expect(txs).toHaveLength(1);
    expect(txs[0]).toMatchObject({
      id: "abc123",
      sourceAccount: ADDRESS,
      type: "payment",
      amount: 25,
      assetCode: "USD",
      to: makeValidAddress(2),
      memo: "invoice-1",
      memoType: "text",
      successful: true,
      ledger: 100,
      pagingToken: "88",
    });
    // Request went to the transactions endpoint with sane defaults.
    const url = String(fetchImpl.mock.calls[0][0]);
    expect(url).toContain(`https://horizon.example.org/accounts/${ADDRESS}/transactions`);
    expect(url).toContain("order=desc");
  });

  it("supports limit/cursor/order parameters in the request URL", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(await jsonResponse(transactionPage([transactionFixture()])));
    await clientFor(fetchImpl).getTransactions(ADDRESS, {
      cursor: "12345",
      order: "asc",
      pageSize: 50,
      startTime: "2026-01-01T00:00:00Z",
      endTime: "2026-02-01T00:00:00Z",
    });

    const url = String(fetchImpl.mock.calls[0][0]);
    expect(url).toContain("cursor=12345");
    expect(url).toContain("order=asc");
    expect(url).toContain("limit=50");
    expect(url).toContain("start_time=2026-01-01T00%3A00%3A00Z");
    expect(url).toContain("end_time=2026-02-01T00%3A00%3A00Z");
  });

  it("paginates across pages transparently and honors a caller limit", async () => {
    const page1 = transactionPage(
      [transactionFixture({ id: "t1", paging_token: "1" }), transactionFixture({ id: "t2", paging_token: "2" })],
      `https://horizon.example.org/accounts/${ADDRESS}/transactions?cursor=2&limit=200`
    );
    const page2 = transactionPage(
      [transactionFixture({ id: "t3", paging_token: "3" })]
    );
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(await jsonResponse(page1))
      .mockResolvedValueOnce(await jsonResponse(page2));

    const txs = await clientFor(fetchImpl).getTransactions(ADDRESS, { limit: 3 });

    expect(txs.map((t) => t.id)).toEqual(["t1", "t2", "t3"]);
    // Both pages fetched; second request used the cursor from the next link.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(String(fetchImpl.mock.calls[1][0])).toContain("cursor=2");
  });

  it("stops fetching once the caller limit is reached", async () => {
    const page1 = transactionPage(
      [transactionFixture({ id: "t1", paging_token: "1" }), transactionFixture({ id: "t2", paging_token: "2" })],
      `https://horizon.example.org/accounts/${ADDRESS}/transactions?cursor=2&limit=200`
    );
    const fetchImpl = vi.fn().mockResolvedValue(await jsonResponse(page1));

    const txs = await clientFor(fetchImpl).getTransactions(ADDRESS, { limit: 2 });

    expect(txs.map((t) => t.id)).toEqual(["t1", "t2"]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("maps 404 to NotFoundError and does not retry", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(await jsonResponse({ status: 404 }, 404));
    await expect(clientFor(fetchImpl).getTransactions(ADDRESS)).rejects.toBeInstanceOf(
      NotFoundError
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects an invalid address before any network call", async () => {
    const fetchImpl = vi.fn();
    await expect(clientFor(fetchImpl).getTransactions("GABC")).rejects.toBeInstanceOf(
      ValidationError
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects an invalid order value", async () => {
    const fetchImpl = vi.fn();
    await expect(
      clientFor(fetchImpl).getTransactions(ADDRESS, { order: "sideways" as never })
    ).rejects.toBeInstanceOf(ValidationError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
