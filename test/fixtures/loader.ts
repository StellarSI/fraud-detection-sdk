/**
 * Loader helper for the recorded Horizon fixtures (issue #84).
 *
 * Tests run fully offline: they read deterministic JSON fixtures instead of
 * hitting live Horizon. This module is the single place that knows where the
 * fixtures live, so a test never hard-codes a path or does its own
 * `fs.readFileSync`.
 *
 * The loader returns plain, parsed JSON shapes that mirror the response types
 * used by `FraudDetector` / `DefaultHorizonClient` (see `src/FraudDetector.ts`):
 * a Horizon "account" object and a Horizon "transactions page" object.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Absolute path to this file's directory (`test/fixtures/`), where the recorded
 * Horizon JSON fixtures live. Resolved from `import.meta.url` so it works under
 * vitest's ESM transform regardless of the package's module type.
 */
export const FIXTURES_DIR = path.dirname(fileURLToPath(import.meta.url));

/**
 * The recorded Horizon account fixtures.
 * - `basic`: a normal account with a native balance plus one trustline.
 * - `manyTrustlines`: an account with several trustlines (asset spam / dusting).
 */
export type AccountFixtureName = "basic" | "manyTrustlines";

/**
 * The recorded Horizon transaction-page fixtures.
 * - `empty`: a page with no records (an account with no history).
 * - `variedMemos`: a page exercising each memo type (text / id / hash / return / none).
 * - `large`: a page with a large record set, for performance / paging sanity.
 */
export type TransactionFixtureName = "empty" | "variedMemos" | "large";

/**
 * Read and parse a named account fixture.
 *
 * @throws {Error} If the fixture file is missing or is not valid JSON.
 */
export function loadAccountFixture(name: AccountFixtureName): unknown {
  const file = path.join(FIXTURES_DIR, `horizon-account-${name}.json`);
  const raw = fs.readFileSync(file, "utf8");
  return JSON.parse(raw);
}

/**
 * Read and parse a named transaction-page fixture.
 *
 * @throws {Error} If the fixture file is missing or is not valid JSON.
 */
export function loadTransactionsFixture(name: TransactionFixtureName): unknown {
  const file = path.join(FIXTURES_DIR, `horizon-tx-${name}.json`);
  const raw = fs.readFileSync(file, "utf8");
  return JSON.parse(raw);
}

/**
 * Convenience: the list of transaction records from a parsed transaction page.
 * Accepts the parsed output of {@link loadTransactionsFixture} and returns its
 * `_embedded.records` array (empty when the page has no records).
 */
export function recordsFromPage(page: unknown): unknown[] {
  const embedded = (page as { _embedded?: { records?: unknown[] } })._embedded;
  return embedded?.records ?? [];
}
