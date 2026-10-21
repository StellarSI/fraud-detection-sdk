/**
 * Tests for the recorded Horizon fixtures (issue #84).
 *
 * Everything here is offline: it reads the committed JSON fixtures through the
 * loader helper and asserts the fixtures are realistic, well-formed and cover
 * the documented edge cases (empty history, many trustlines, every memo
 * type). No network access is required.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it, expect } from "vitest";
import {
  FIXTURES_DIR,
  loadAccountFixture,
  loadTransactionsFixture,
  recordsFromPage,
} from "./fixtures/loader.js";

type AccountFixture = {
  id: string;
  sequence: string;
  balances: Array<{ asset_type: string; asset_code?: string; balance: string }>;
  signers: Array<{ weight: number; key: string; type: string }>;
};

type TxRecord = {
  id: string;
  type: string;
  memo_type?: string;
  memo?: string;
};
type TxFixture = { _embedded: { records: TxRecord[] }; _links: Record<string, unknown> };

describe("Horizon fixtures (#84)", () => {
  it("fixtures directory exists and is populated", () => {
    expect(fs.existsSync(FIXTURES_DIR)).toBe(true);
    const files = fs.readdirSync(FIXTURES_DIR);
    expect(files.some((f) => f.endsWith(".json"))).toBe(true);
  });

  it("loads the basic account fixture with a native + trustline balance", () => {
    const account = loadAccountFixture("basic") as AccountFixture;
    expect(account.id).toMatch(/^G/);
    expect(account.balances).toHaveLength(2);
    expect(account.balances[0].asset_type).toBe("native");
    expect(account.balances[1].asset_code).toBe("USDC");
    expect(account.signers.length).toBeGreaterThan(0);
  });

  it("the many-trustlines fixture exercises asset spam", () => {
    const account = loadAccountFixture("manyTrustlines") as AccountFixture;
    const nonNative = account.balances.filter((b) => b.asset_type !== "native");
    expect(nonNative.length).toBeGreaterThanOrEqual(5);
    // A zero-balance trustline (dusting) is present.
    expect(nonNative.some((b) => b.balance === "0.0000000")).toBe(true);
  });

  it("the empty-transaction fixture has no records", () => {
    const page = loadTransactionsFixture("empty") as TxFixture;
    expect(recordsFromPage(page)).toEqual([]);
    expect(page._embedded.records).toHaveLength(0);
  });

  it("the varied-memos fixture covers every supported memo type", () => {
    const page = loadTransactionsFixture("variedMemos") as TxFixture;
    const memos = new Set(recordsFromPage(page).map((r) => r.memo_type));
    for (const required of ["text", "id", "hash", "return", "none"] as const) {
      expect(memos.has(required)).toBe(true);
    }
  });

  it("the large-transaction fixture is sizable but still parses", () => {
    const page = loadTransactionsFixture("large") as TxFixture;
    const records = recordsFromPage(page);
    expect(records.length).toBeGreaterThanOrEqual(100);
    expect(records.every((r) => typeof r.id === "string")).toBe(true);
  });

  it("every committed fixture is valid JSON", () => {
    const jsonFiles = fs
      .readdirSync(FIXTURES_DIR)
      .filter((f) => f.endsWith(".json"))
      .map((f) => path.join(FIXTURES_DIR, f));
    expect(jsonFiles.length).toBeGreaterThanOrEqual(5);
    for (const file of jsonFiles) {
      expect(() => JSON.parse(fs.readFileSync(file, "utf8"))).not.toThrow();
    }
  });
});
