/**
 * Tests for asset feature extraction (issue #21).
 *
 * Covers accounts with zero, few, and many trustlines, canonical
 * `CODE:ISSUER` identifiers, issuer concentration, clawback/authorization
 * signals, trustline churn from the transaction history, and the
 * registry-ready provider.
 */

import { describe, it, expect } from "vitest";
import type { Account, AccountBalance, Transaction } from "../clients/horizon.js";
import { ValidationError } from "../errors.js";
import {
  DEFAULT_TRUSTLINE_CHURN_WINDOW_MS,
  canonicalAssetId,
  extractAssetFeatures,
  assetFeaturesToFeatureMap,
  createAssetFeatureProvider,
} from "./assets.js";

const VALID_ACCOUNT = "GABCDEFGHIJKLMNOPQRSTUVWXYZABCDEFGHIJKLMNOPQRSTUVWXYZABCDEF";
const REFERENCE = "2026-01-01T12:00:00.000Z";
const REFERENCE_MS = Date.parse(REFERENCE);
const DAY_MS = 24 * 60 * 60 * 1000;

function makeBalance(overrides: Partial<AccountBalance> = {}): AccountBalance {
  return {
    code: "XLM",
    type: "native",
    amount: 1000,
    clawbackEnabled: false,
    authorized: true,
    ...overrides,
  };
}

function makeAccount(
  balances: AccountBalance[],
  overrides: Partial<Account> = {}
): Account {
  return {
    id: VALID_ACCOUNT,
    sequence: 1,
    sequenceString: "1",
    signatureThreshold: 0,
    subentryCount: balances.length,
    thresholds: { low: 0, medium: 0, high: 0 },
    balances,
    signers: [],
    data: {},
    lastLedger: 1,
    pagingToken: "1",
    ...overrides,
  };
}

function changeTrustTx(overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: "ct-1",
    createdAt: REFERENCE,
    sourceAccount: VALID_ACCOUNT,
    type: "change_trust",
    amount: 0,
    pagingToken: "1",
    ...overrides,
  };
}

function paymentTx(overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: "pay-1",
    createdAt: REFERENCE,
    sourceAccount: VALID_ACCOUNT,
    type: "payment",
    amount: 10,
    assetCode: "XLM",
    pagingToken: "1",
    ...overrides,
  };
}

describe("canonicalAssetId", () => {
  it("reports the native asset as XLM", () => {
    expect(canonicalAssetId(makeBalance())).toBe("XLM");
    expect(canonicalAssetId(makeBalance({ type: "native", code: "" }))).toBe("XLM");
  });

  it("normalizes issued assets to canonical CODE:ISSUER form", () => {
    expect(
      canonicalAssetId(
        makeBalance({ type: "credit_alphanum4", code: "usdc", issuer: "GISSUER1" })
      )
    ).toBe("USDC:GISSUER1");
    expect(
      canonicalAssetId(
        makeBalance({ type: "credit_alphanum12", code: "LongCode12", issuer: "GISSUER2" })
      )
    ).toBe("LONGCODE12:GISSUER2");
  });

  it("falls back to deterministic placeholders for malformed entries", () => {
    expect(
      canonicalAssetId(makeBalance({ type: "credit_alphanum4", code: "USDC", issuer: undefined }))
    ).toBe("USDC:UNKNOWN");
    expect(
      canonicalAssetId(makeBalance({ type: "credit_alphanum4", code: "", issuer: "GISSUER1" }))
    ).toBe("UNKNOWN:GISSUER1");
  });
});

describe("extractAssetFeatures", () => {
  it("handles an account with zero trustlines (native only)", () => {
    const account = makeAccount([makeBalance({ amount: 1234.5 })]);
    const features = extractAssetFeatures(account, { now: REFERENCE });

    expect(features.balanceCount).toBe(1);
    expect(features.nativeBalance).toBe(1234.5);
    expect(features.issuedBalanceCount).toBe(0);
    expect(features.trustlineCount).toBe(0);
    expect(features.zeroBalanceTrustlineCount).toBe(0);
    expect(features.assetDiversity).toBe(1);
    expect(features.issuerDiversity).toBe(0);
    expect(features.issuerConcentration).toBe(0);
    expect(features.topIssuer).toBeNull();
    expect(features.authorizedTrustlineCount).toBe(0);
    expect(features.unauthorizedTrustlineCount).toBe(0);
    expect(features.clawbackEnabledCount).toBe(0);
    expect(features.assetIds).toEqual(["XLM"]);
    expect(features.trustlineChanges).toBe(0);
    expect(features.referenceTime).toBe(REFERENCE);
  });

  it("handles an account with a few trustlines", () => {
    const account = makeAccount([
      makeBalance({ amount: 500 }),
      makeBalance({
        type: "credit_alphanum4",
        code: "USDC",
        issuer: "GISSUER2",
        amount: 25,
      }),
      makeBalance({
        type: "credit_alphanum4",
        code: "EURT",
        issuer: "GISSUER1",
        amount: 0,
      }),
    ]);

    const features = extractAssetFeatures(account, { now: REFERENCE });

    expect(features.balanceCount).toBe(3);
    expect(features.nativeBalance).toBe(500);
    expect(features.issuedBalanceCount).toBe(2);
    expect(features.trustlineCount).toBe(2);
    expect(features.zeroBalanceTrustlineCount).toBe(1);
    expect(features.assetDiversity).toBe(3);
    expect(features.issuerDiversity).toBe(2);
    expect(features.issuerConcentration).toBe(0.5);
    expect(features.topIssuer).toBe("GISSUER1"); // tie breaks lexicographically
    expect(features.assetIds).toEqual(["EURT:GISSUER1", "USDC:GISSUER2", "XLM"]);
    expect(features.authorizedTrustlineCount).toBe(2);
  });

  it("handles an account with many trustlines from a dominant issuer", () => {
    const spammed = ["AAA", "BBB", "CCC", "DDD", "EEE", "FFF"].map((code) =>
      makeBalance({
        type: "credit_alphanum4",
        code,
        issuer: "GSPAMMER",
        amount: 10,
        clawbackEnabled: true,
      })
    );
    const others = [
      makeBalance({
        type: "credit_alphanum4",
        code: "GGG",
        issuer: "GISSUER9",
        amount: 10,
        authorized: false,
      }),
      makeBalance({
        type: "credit_alphanum4",
        code: "HHH",
        issuer: "GISSUER9",
        amount: 0,
        authorized: false,
      }),
    ];
    const account = makeAccount([makeBalance({ amount: 800 }), ...spammed, ...others]);

    const features = extractAssetFeatures(account, { now: REFERENCE });

    expect(features.issuedBalanceCount).toBe(8);
    expect(features.trustlineCount).toBe(8);
    expect(features.assetDiversity).toBe(9); // XLM + 8 issued assets
    expect(features.issuerDiversity).toBe(2);
    expect(features.issuerConcentration).toBe(0.75); // 6 of 8 trustlines from GSPAMMER
    expect(features.topIssuer).toBe("GSPAMMER");
    expect(features.zeroBalanceTrustlineCount).toBe(1);
    expect(features.clawbackEnabledCount).toBe(6);
    expect(features.unauthorizedTrustlineCount).toBe(2);
    expect(features.authorizedTrustlineCount).toBe(6);
    expect(features.assetIds).toEqual([
      "AAA:GSPAMMER",
      "BBB:GSPAMMER",
      "CCC:GSPAMMER",
      "DDD:GSPAMMER",
      "EEE:GSPAMMER",
      "FFF:GSPAMMER",
      "GGG:GISSUER9",
      "HHH:GISSUER9",
      "XLM",
    ]);
  });

  it("counts trustline churn from change_trust transactions in the window", () => {
    const transactions = [
      changeTrustTx({ id: "recent", createdAt: new Date(REFERENCE_MS - 2 * DAY_MS).toISOString() }),
      changeTrustTx({
        id: "boundary",
        createdAt: new Date(REFERENCE_MS - DEFAULT_TRUSTLINE_CHURN_WINDOW_MS).toISOString(),
      }),
      changeTrustTx({
        id: "old",
        createdAt: new Date(REFERENCE_MS - 30 * DAY_MS).toISOString(),
      }),
      changeTrustTx({
        id: "future",
        createdAt: new Date(REFERENCE_MS + DAY_MS).toISOString(),
      }),
      paymentTx({ id: "not-trust", createdAt: REFERENCE }),
    ];
    const account = makeAccount([makeBalance()]);

    const features = extractAssetFeatures(account, {
      now: REFERENCE,
      transactions,
    });

    // "recent" and the exact window-start boundary both count.
    expect(features.trustlineChanges).toBe(2);
  });

  it("honors a custom churn window", () => {
    const transactions = [
      changeTrustTx({ createdAt: new Date(REFERENCE_MS - DAY_MS).toISOString() }),
      changeTrustTx({ createdAt: new Date(REFERENCE_MS - 5 * DAY_MS).toISOString() }),
    ];
    const account = makeAccount([makeBalance()]);

    const features = extractAssetFeatures(account, {
      now: REFERENCE,
      transactions,
      churnWindowMs: 2 * DAY_MS,
    });

    expect(features.trustlineChanges).toBe(1);
    expect(features.trustlineChurnMs).toBe(2 * DAY_MS);
  });

  it("yields zero churn for an empty or absent history", () => {
    const account = makeAccount([makeBalance()]);
    expect(
      extractAssetFeatures(account, { now: REFERENCE, transactions: [] }).trustlineChanges
    ).toBe(0);
    expect(extractAssetFeatures(account, { now: REFERENCE }).trustlineChanges).toBe(0);
  });

  it("rejects invalid options", () => {
    const account = makeAccount([makeBalance()]);
    expect(() => extractAssetFeatures(account, { churnWindowMs: 0 })).toThrow(ValidationError);
    expect(() => extractAssetFeatures(account, { churnWindowMs: -1 })).toThrow(ValidationError);
    expect(() => extractAssetFeatures(account, { now: "not-a-date" })).toThrow(ValidationError);
    // @ts-expect-error - transactions must be an array at runtime
    expect(() => extractAssetFeatures(account, { transactions: "yes" })).toThrow(ValidationError);
    // @ts-expect-error - account is required at runtime
    expect(() => extractAssetFeatures(null)).toThrow(ValidationError);
  });

  it("tolerates malformed balance entries", () => {
    const account = makeAccount([
      makeBalance(),
      { type: "credit_alphanum4", amount: 0 } as unknown as AccountBalance,
    ]);
    const features = extractAssetFeatures(account, { now: REFERENCE });
    expect(features.issuedBalanceCount).toBe(1);
    expect(features.assetIds).toEqual(["UNKNOWN:UNKNOWN", "XLM"]);
  });
});

describe("assetFeaturesToFeatureMap", () => {
  it("flattens features into a scalar map", () => {
    const account = makeAccount([
      makeBalance({ amount: 500 }),
      makeBalance({ type: "credit_alphanum4", code: "USDC", issuer: "GISSUER2", amount: 25 }),
    ]);
    const map = assetFeaturesToFeatureMap(extractAssetFeatures(account, { now: REFERENCE }));

    expect(map.assetTrustlineCount).toBe(1);
    expect(map.assetDiversity).toBe(2);
    expect(map.assetNativeBalance).toBe(500);
    expect(map.assetTopIssuer).toBe("GISSUER2");
    // Distinct scalars only — the canonical id list stays on AssetFeatures.
    expect(Object.values(map).every((value) =>
      ["number", "string", "boolean"].includes(typeof value) || value === null
    )).toBe(true);
  });
});

describe("createAssetFeatureProvider", () => {
  it("computes features from the shared context account and transactions", () => {
    const provider = createAssetFeatureProvider();
    const account = makeAccount([
      makeBalance({ amount: 100 }),
      makeBalance({ type: "credit_alphanum4", code: "USDC", issuer: "GISSUER2", amount: 1 }),
    ]);
    const transactions = [changeTrustTx({ createdAt: REFERENCE })];

    const map = provider.compute({ account, transactions, now: REFERENCE });

    expect(provider.name).toBe("assets");
    expect(map.assetTrustlineCount).toBe(1);
    expect(map.assetTrustlineChanges).toBe(1);
  });

  it("rejects a context without a normalized account", () => {
    const provider = createAssetFeatureProvider();
    expect(() => provider.compute({ transactions: [], now: REFERENCE })).toThrow(
      ValidationError
    );
  });
});
