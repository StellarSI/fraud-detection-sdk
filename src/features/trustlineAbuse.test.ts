/**
 * Tests for trustline-abuse and asset-spam features (issue #27).
 *
 * Acceptance criteria: trustline count and churn come from features,
 * bursts and extreme counts are detected, and thresholds are configurable.
 * Cases cover normal, spammy, and burst patterns.
 */

import { describe, it, expect } from "vitest";
import type {
  Account,
  AccountBalance,
  Transaction,
} from "../clients/horizon.js";
import { ValidationError } from "../errors.js";
import {
  DEFAULT_TRUSTLINE_BURST_THRESHOLD,
  extractTrustlineAbuseFeatures,
  isChangeTrustTransaction,
  createTrustlineAbuseFeatureProvider,
  trustlineAbuseFeaturesToFeatureMap,
} from "./trustlineAbuse.js";

const NOW = "2026-01-01T12:00:00.000Z";

function account(balances: AccountBalance[]): Account {
  return {
    id: "GACCOUNT",
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
  };
}

function issued(
  code: string,
  issuer: string,
  amount = 10,
  extra: Partial<AccountBalance> = {}
): AccountBalance {
  return {
    code,
    issuer,
    type: "credit_alphanum4",
    amount,
    clawbackEnabled: false,
    authorized: true,
    ...extra,
  };
}

const native: AccountBalance = {
  code: "XLM",
  type: "native",
  amount: 100,
  clawbackEnabled: false,
  authorized: true,
};

function trustlines(count: number, options: { zero?: number; issuer?: string } = {}) {
  const zero = options.zero ?? 0;
  return Array.from({ length: count }, (_, index) =>
    issued(
      `AST${index}`,
      options.issuer ?? `GISSUER${index}`,
      index < zero ? 0 : 10
    )
  );
}

let nextId = 0;
function changeTrust(overrides: Partial<Transaction> = {}): Transaction {
  nextId += 1;
  return {
    id: `ct-${nextId}`,
    createdAt: "2026-01-01T11:30:00.000Z",
    sourceAccount: "GACCOUNT",
    type: "change_trust",
    amount: 0,
    assetCode: "USD",
    assetIssuer: "GISSUER1",
    pagingToken: String(nextId),
    ...overrides,
  };
}

function burst(count: number, options: { startMinute?: number; issuer?: string } = {}) {
  const start = options.startMinute ?? 30;
  return Array.from({ length: count }, (_, index) =>
    changeTrust({
      createdAt: new Date(
        Date.UTC(2026, 0, 1, 11, start + index)
      ).toISOString(),
      assetCode: `AST${index}`,
      assetIssuer: options.issuer ?? `GISSUER${index}`,
    })
  );
}

describe("extractTrustlineAbuseFeatures - normal account", () => {
  it("reports a low score for a small, stable trustline set", () => {
    const features = extractTrustlineAbuseFeatures(
      account([native, ...trustlines(3)]),
      { transactions: [], now: NOW }
    );

    expect(features.trustlineCount).toBe(3);
    expect(features.churnCount).toBe(0);
    expect(features.burstCount).toBe(0);
    expect(features.burstDetected).toBe(false);
    expect(features.dustCount).toBe(0);
    expect(features.extremeCountDetected).toBe(false);
    expect(features.abuseScore).toBeLessThan(0.05);
  });

  it("yields zeroed window features for an empty history", () => {
    const features = extractTrustlineAbuseFeatures(account([native]), {
      now: NOW,
    });

    expect(features.trustlineCount).toBe(0);
    expect(features.churnCount).toBe(0);
    expect(features.burstCount).toBe(0);
    expect(features.distinctIssuersInWindow).toBe(0);
    expect(features.referenceTime).toBe(new Date(NOW).toISOString());
  });
});

describe("extractTrustlineAbuseFeatures - spammy account", () => {
  it("flags extreme trustline counts and dusting", () => {
    const features = extractTrustlineAbuseFeatures(
      account([native, ...trustlines(120, { zero: 100, issuer: "GSPAM" })]),
      { transactions: [], now: NOW }
    );

    expect(features.trustlineCount).toBe(120);
    expect(features.extremeCountDetected).toBe(true);
    expect(features.dustCount).toBe(100);
    expect(features.dustRatio).toBeCloseTo(100 / 120);
    expect(features.issuerConcentration).toBe(1);
    expect(features.abuseScore).toBeGreaterThan(0.3);
  });

  it("computes churn and issuer spread from change_trust history", () => {
    const features = extractTrustlineAbuseFeatures(
      account([native, ...trustlines(120, { zero: 100 })]),
      { transactions: burst(12), now: NOW }
    );

    expect(features.churnCount).toBe(12);
    expect(features.distinctIssuersInWindow).toBe(12);
    expect(features.distinctAssetsInWindow).toBe(12);
  });
});

describe("extractTrustlineAbuseFeatures - burst pattern", () => {
  it("detects a rapid creation burst", () => {
    const features = extractTrustlineAbuseFeatures(
      account([native, ...trustlines(3)]),
      { transactions: burst(12), now: NOW }
    );

    expect(features.burstCount).toBe(12);
    expect(features.burstDetected).toBe(true);
    expect(features.churnCount).toBe(12);
    expect(features.abuseScore).toBeGreaterThan(0.5);
  });

  it("uses the max count inside any burst window, not the total", () => {
    const history = [
      ...burst(5, { startMinute: 30 }).map((tx) =>
        // First cluster ~90 minutes before the reference time.
        ({ ...tx, createdAt: "2026-01-01T09:30:00.000Z" })
      ),
      ...burst(8, { startMinute: 0 }),
    ];

    const features = extractTrustlineAbuseFeatures(
      account([native, ...trustlines(3)]),
      { transactions: history, now: NOW, burstWindowMs: 60 * 60 * 1000 }
    );

    expect(features.churnCount).toBe(13);
    expect(features.burstCount).toBe(8);
    // 8 is below the default threshold (10), unlike the total (13): the
    // windowed max is what counts, not the aggregate.
    expect(features.burstDetected).toBe(false);
  });

  it("ignores change_trust operations outside the churn window", () => {
    const old = changeTrust({
      createdAt: "2025-12-20T12:00:00.000Z", // > 7 days before NOW
    });

    const features = extractTrustlineAbuseFeatures(
      account([native, ...trustlines(3)]),
      { transactions: [old], now: NOW }
    );

    expect(features.churnCount).toBe(0);
    expect(features.burstCount).toBe(0);
    expect(features.distinctIssuersInWindow).toBe(0);
  });

  it("honors a custom churn window", () => {
    const history = burst(4, { startMinute: 0 }); // 11:00-11:03

    const features = extractTrustlineAbuseFeatures(
      account([native, ...trustlines(3)]),
      {
        transactions: history,
        now: NOW,
        churnWindowMs: 30 * 60 * 1000, // 11:30-12:00 only
      }
    );

    expect(features.churnCount).toBe(0);
    expect(features.burstCount).toBe(0);
  });
});

describe("extractTrustlineAbuseFeatures - configurable thresholds", () => {
  it("honors extremeTrustlineCount", () => {
    const data = account([native, ...trustlines(6)]);

    expect(
      extractTrustlineAbuseFeatures(data, { now: NOW }).extremeCountDetected
    ).toBe(false);
    expect(
      extractTrustlineAbuseFeatures(data, {
        now: NOW,
        extremeTrustlineCount: 5,
      }).extremeCountDetected
    ).toBe(true);
  });

  it("honors burstThreshold", () => {
    const data = account([native, ...trustlines(3)]);
    const history = burst(3);

    expect(
      extractTrustlineAbuseFeatures(data, {
        transactions: history,
        now: NOW,
      }).burstDetected
    ).toBe(false);
    expect(
      extractTrustlineAbuseFeatures(data, {
        transactions: history,
        now: NOW,
        burstThreshold: 3,
      }).burstDetected
    ).toBe(true);
  });

  it("honors spamIssuerCount when scoring", () => {
    const data = account([native, ...trustlines(3)]);
    const history = burst(4);

    const lenient = extractTrustlineAbuseFeatures(data, {
      transactions: history,
      now: NOW,
      spamIssuerCount: 100,
    });
    const strict = extractTrustlineAbuseFeatures(data, {
      transactions: history,
      now: NOW,
      spamIssuerCount: 4,
    });

    expect(strict.abuseScore).toBeGreaterThan(lenient.abuseScore);
  });

  it("rejects invalid thresholds", () => {
    const data = account([native]);

    expect(() =>
      extractTrustlineAbuseFeatures(data, { now: NOW, burstWindowMs: 0 })
    ).toThrow(ValidationError);
    expect(() =>
      extractTrustlineAbuseFeatures(data, {
        now: NOW,
        dustRatioThreshold: 1.5,
      })
    ).toThrow(ValidationError);
    expect(() =>
      extractTrustlineAbuseFeatures(data, { now: "not-a-date" })
    ).toThrow(ValidationError);
  });
});

describe("trustline abuse feature map and provider", () => {
  it("flattens features into the registry map", () => {
    const features = extractTrustlineAbuseFeatures(
      account([native, ...trustlines(120, { zero: 100 })]),
      { transactions: burst(12), now: NOW }
    );
    const map = trustlineAbuseFeaturesToFeatureMap(features);

    expect(map["trustlineCount"]).toBe(120);
    expect(map["trustlineBurstCount"]).toBe(12);
    expect(map["trustlineBurstDetected"]).toBe(true);
    expect(map["trustlineExceedsExtremeCount"]).toBe(true);
    expect(typeof map["trustlineAbuseScore"]).toBe("number");
  });

  it("runs as a registry provider over the shared context", () => {
    const provider = createTrustlineAbuseFeatureProvider();
    const map = provider.compute({
      account: account([native, ...trustlines(3)]),
      transactions: burst(12),
      now: NOW,
    });

    expect(provider.name).toBe("trustlineAbuse");
    expect(map["trustlineBurstCount"]).toBe(12);
  });

  it("requires a normalized account", () => {
    const provider = createTrustlineAbuseFeatureProvider();
    expect(() =>
      provider.compute({ transactions: [], now: NOW })
    ).toThrow(ValidationError);
  });
});

describe("isChangeTrustTransaction", () => {
  it("recognizes change_trust spellings", () => {
    expect(isChangeTrustTransaction(changeTrust())).toBe(true);
    expect(
      isChangeTrustTransaction(
        changeTrust({ type: "" }) as Transaction & { operationType?: string }
      )
    ).toBe(false);
    expect(
      isChangeTrustTransaction({
        ...changeTrust({ type: "" }),
        operationType: "change-trust",
      })
    ).toBe(true);
  });

  it("ignores unrelated operations", () => {
    expect(isChangeTrustTransaction(changeTrust({ type: "payment" }))).toBe(
      false
    );
    expect(
      isChangeTrustTransaction(
        changeTrust({ type: "CHANGE_TRUST" })
      )
    ).toBe(true);
  });

  it("default burst threshold is 10", () => {
    expect(DEFAULT_TRUSTLINE_BURST_THRESHOLD).toBe(10);
  });
});
