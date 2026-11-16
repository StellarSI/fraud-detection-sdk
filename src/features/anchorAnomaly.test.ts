/**
 * Tests for the anchor deposit/withdrawal anomaly feature extractor (#34).
 *
 * Acceptance criteria: anchor-related transactions are identified via
 * configurable asset/issuer identifiers; irregular memo and amount
 * patterns are surfaced as features; identification is configurable;
 * empty histories yield zeroed features; computation is deterministic.
 */

import { describe, it, expect } from "vitest";
import type { Transaction } from "../clients/horizon.js";
import {
  DEFAULT_ANCHOR_OUTLIER_Z_SCORE,
  extractAnchorAnomalyFeatures,
  anchorAnomalyFeaturesToFeatureMap,
  createAnchorAnomalyFeatureProvider,
  canonicalTransactionAssetId,
} from "./anchorAnomaly.js";

const ACCOUNT =
  "GACCOUNT00000000000000000000000000000000000000000000000000";
const ANCHOR_ISSUER =
  "GANCHORISSUER000000000000000000000000000000000000000000000";
const OTHER_ISSUER =
  "GOTHERISSUER00000000000000000000000000000000000000000000000";

let nextId = 0;
function makeTx(overrides: Partial<Transaction> = {}): Transaction {
  nextId += 1;
  return {
    id: `anchor-tx-${nextId}`,
    createdAt: "2026-01-01T12:00:00.000Z",
    sourceAccount: ACCOUNT,
    type: "payment",
    amount: 100,
    assetCode: "USD",
    assetIssuer: ANCHOR_ISSUER,
    pagingToken: String(nextId),
    ...overrides,
  };
}

const ANCHOR_OPTIONS = {
  accountId: ACCOUNT,
  anchorAssetCodes: ["USD"],
} as const;

describe("extractAnchorAnomalyFeatures - identification", () => {
  it("identifies transactions matching an anchor asset code", () => {
    const txs = [
      makeTx({ amount: 10 }),
      makeTx({ amount: 20 }),
      makeTx({ amount: 999, assetCode: "DOGE", assetIssuer: OTHER_ISSUER }),
    ];
    const features = extractAnchorAnomalyFeatures(txs, ANCHOR_OPTIONS);

    expect(features.anchorTransactionCount).toBe(2);
    expect(features.anchorTotalVolume).toBe(30);
  });

  it("identifies transactions matching an anchor issuer", () => {
    const txs = [
      makeTx({ assetCode: "USDC", assetIssuer: ANCHOR_ISSUER }),
      makeTx({ assetCode: "OTHER", assetIssuer: OTHER_ISSUER }),
    ];
    const features = extractAnchorAnomalyFeatures(txs, {
      anchorAssetIssuers: [ANCHOR_ISSUER],
    });

    expect(features.anchorTransactionCount).toBe(1);
  });

  it("identifies transactions matching a canonical CODE:ISSUER entry", () => {
    const txs = [
      makeTx({ assetCode: "USD", assetIssuer: ANCHOR_ISSUER }),
      makeTx({ assetCode: "USD", assetIssuer: OTHER_ISSUER }),
    ];
    const features = extractAnchorAnomalyFeatures(txs, {
      anchorAssets: [`USD:${ANCHOR_ISSUER}`],
    });

    expect(features.anchorTransactionCount).toBe(1);
  });

  it("identifies the native asset via XLM", () => {
    const txs = [
      makeTx({ assetCode: "XLM", assetIssuer: undefined }),
      makeTx({ assetCode: "USD", assetIssuer: ANCHOR_ISSUER }),
    ];
    const features = extractAnchorAnomalyFeatures(txs, {
      anchorAssets: ["XLM", `USD:${ANCHOR_ISSUER}`],
    });

    expect(features.anchorTransactionCount).toBe(2);
  });

  it("identifies nothing when no anchor identifiers are configured", () => {
    const txs = [makeTx(), makeTx()];
    const features = extractAnchorAnomalyFeatures(txs);

    expect(features.anchorTransactionCount).toBe(0);
    expect(features.anchorMemoMissingCount).toBe(0);
    expect(features.anchorAmountMax).toBe(0);
  });

  it("splits direction relative to the scored account", () => {
    const txs = [
      makeTx({ to: ACCOUNT, from: "GCOUNTERPARTY" }),
      makeTx({ to: ACCOUNT, from: "GCOUNTERPARTY" }),
      makeTx({ to: "GCOUNTERPARTY", from: ACCOUNT }),
    ];
    const features = extractAnchorAnomalyFeatures(txs, ANCHOR_OPTIONS);

    expect(features.anchorInboundCount).toBe(2);
    expect(features.anchorOutboundCount).toBe(1);
  });

  it("reports no direction counts when the account is unknown", () => {
    const txs = [makeTx({ to: ACCOUNT })];
    const features = extractAnchorAnomalyFeatures(txs, { anchorAssetCodes: ["USD"] });

    expect(features.anchorInboundCount).toBe(0);
    expect(features.anchorOutboundCount).toBe(0);
  });
});

describe("extractAnchorAnomalyFeatures - amount distribution", () => {
  it("computes mean, min, max, stddev, and max share", () => {
    const txs = [10, 20, 30, 40].map((amount) => makeTx({ amount }));
    const features = extractAnchorAnomalyFeatures(txs, ANCHOR_OPTIONS);

    expect(features.anchorTotalVolume).toBe(100);
    expect(features.anchorAmountMean).toBe(25);
    expect(features.anchorAmountMin).toBe(10);
    expect(features.anchorAmountMax).toBe(40);
    expect(features.anchorAmountStdDev).toBeCloseTo(Math.sqrt(125), 5);
    expect(features.anchorAmountMaxShare).toBeCloseTo(0.4, 5);
    expect(features.anchorAmountOutlierCount).toBe(0);
  });

  it("flags a dominant transfer as an outlier", () => {
    const amounts = [...Array(9).fill(10), 1000];
    const txs = amounts.map((amount) => makeTx({ amount }));
    const features = extractAnchorAnomalyFeatures(txs, ANCHOR_OPTIONS);

    expect(features.anchorAmountOutlierCount).toBeGreaterThanOrEqual(1);
    expect(features.anchorAmountMaxShare).toBeGreaterThan(0.8);
  });

  it("honors a custom z-score threshold", () => {
    const amounts = [...Array(9).fill(10), 1000];
    const txs = amounts.map((amount) => makeTx({ amount }));
    const features = extractAnchorAnomalyFeatures(txs, {
      ...ANCHOR_OPTIONS,
      zScoreThreshold: 10,
    });

    expect(features.anchorAmountOutlierCount).toBe(0);
  });

  it("exposes the default z-score", () => {
    expect(DEFAULT_ANCHOR_OUTLIER_Z_SCORE).toBe(2);
  });
});

describe("extractAnchorAnomalyFeatures - memo patterns", () => {
  it("counts missing, present, id, distinct, and reused memos", () => {
    const txs = [
      makeTx({ memo: "dep-1", memoType: "id" }),
      makeTx({ memo: "dep-1", memoType: "id" }),
      makeTx({ memo: "dep-2", memoType: "id" }),
      makeTx(),
      makeTx(),
    ];
    const features = extractAnchorAnomalyFeatures(txs, ANCHOR_OPTIONS);

    expect(features.anchorTransactionCount).toBe(5);
    expect(features.anchorMemoCount).toBe(3);
    expect(features.anchorMemoMissingCount).toBe(2);
    expect(features.anchorMemoIdCount).toBe(3);
    expect(features.anchorMemoDistinctCount).toBe(2);
    expect(features.anchorMemoReusedCount).toBe(1);
    expect(features.anchorMemoMaxReuseCount).toBe(2);
    expect(features.anchorMemoShare).toBeCloseTo(0.6, 5);
  });

  it("gives a zero memo share when no anchor transaction carries a memo", () => {
    const txs = [makeTx(), makeTx()];
    const features = extractAnchorAnomalyFeatures(txs, ANCHOR_OPTIONS);

    expect(features.anchorMemoCount).toBe(0);
    expect(features.anchorMemoShare).toBe(0);
  });
});

describe("extractAnchorAnomalyFeatures - edge cases", () => {
  it("yields zeroed features for an empty history", () => {
    const features = extractAnchorAnomalyFeatures([], ANCHOR_OPTIONS);

    expect(features.anchorTransactionCount).toBe(0);
    expect(features.anchorAmountMean).toBe(0);
    expect(features.anchorAmountMin).toBe(0);
    expect(features.anchorAmountStdDev).toBe(0);
    expect(features.anchorAmountOutlierCount).toBe(0);
    expect(features.anchorMemoShare).toBe(0);
  });

  it("tolerates malformed entries without throwing", () => {
    const txs = [
      null,
      undefined,
      "junk",
      makeTx({ amount: Number.NaN }),
    ] as unknown as Transaction[];
    const features = extractAnchorAnomalyFeatures(txs, ANCHOR_OPTIONS);

    expect(features.anchorTransactionCount).toBe(1);
    expect(features.anchorTotalVolume).toBe(0);
  });

  it("rejects a non-array history", () => {
    expect(() =>
      extractAnchorAnomalyFeatures("nope" as unknown as Transaction[], ANCHOR_OPTIONS)
    ).toThrow();
  });

  it("rejects invalid options", () => {
    expect(() =>
      extractAnchorAnomalyFeatures([], { anchorAssets: ["USD:"] })
    ).toThrow();
    expect(() =>
      extractAnchorAnomalyFeatures([], { anchorAssets: [""] })
    ).toThrow();
    expect(() =>
      extractAnchorAnomalyFeatures([], { anchorAssets: "USD" as unknown as string[] })
    ).toThrow();
    expect(() => extractAnchorAnomalyFeatures([], { zScoreThreshold: 0 })).toThrow();
    expect(() =>
      extractAnchorAnomalyFeatures([], { zScoreThreshold: Number.NaN })
    ).toThrow();
  });

  it("is deterministic for identical input", () => {
    const txs = [makeTx({ amount: 5 }), makeTx({ amount: 500 })];
    const a = extractAnchorAnomalyFeatures(txs, ANCHOR_OPTIONS);
    const b = extractAnchorAnomalyFeatures(txs, ANCHOR_OPTIONS);

    expect(a).toEqual(b);
  });

  it("canonicalizes transaction asset ids", () => {
    expect(canonicalTransactionAssetId(makeTx({ assetCode: "xlm", assetIssuer: undefined }))).toBe(
      "XLM"
    );
    expect(
      canonicalTransactionAssetId(makeTx({ assetCode: "usd", assetIssuer: ANCHOR_ISSUER }))
    ).toBe(`USD:${ANCHOR_ISSUER}`);
  });
});

describe("anchorAnomalyFeaturesToFeatureMap", () => {
  it("exports all scalar feature values", () => {
    const features = extractAnchorAnomalyFeatures(
      [makeTx({ amount: 10, memo: "m", memoType: "text" })],
      ANCHOR_OPTIONS
    );
    const map = anchorAnomalyFeaturesToFeatureMap(features);

    for (const key of [
      "anchorTransactionCount",
      "anchorInboundCount",
      "anchorOutboundCount",
      "anchorDistinctAssetCount",
      "anchorTotalVolume",
      "anchorAmountMean",
      "anchorAmountMin",
      "anchorAmountMax",
      "anchorAmountStdDev",
      "anchorAmountMaxShare",
      "anchorAmountOutlierCount",
      "anchorMemoCount",
      "anchorMemoMissingCount",
      "anchorMemoIdCount",
      "anchorMemoDistinctCount",
      "anchorMemoReusedCount",
      "anchorMemoMaxReuseCount",
      "anchorMemoShare",
    ]) {
      expect(typeof map[key]).toBe("number");
    }
  });
});

describe("createAnchorAnomalyFeatureProvider", () => {
  it("computes from the shared feature context", () => {
    const provider = createAnchorAnomalyFeatureProvider({
      anchorAssetCodes: ["USD"],
    });
    const map = provider.compute({
      accountId: ACCOUNT,
      transactions: [makeTx({ amount: 42, to: ACCOUNT })],
    });

    expect(provider.name).toBe("anchor-anomaly");
    expect(map.anchorTransactionCount).toBe(1);
    expect(map.anchorInboundCount).toBe(1);
    expect(map.anchorTotalVolume).toBe(42);
  });

  it("prefers the context accountId over the option", () => {
    const provider = createAnchorAnomalyFeatureProvider({
      anchorAssetCodes: ["USD"],
      accountId: "GOPTION",
    });
    const map = provider.compute({
      accountId: ACCOUNT,
      transactions: [makeTx({ to: ACCOUNT })],
    });

    expect(map.anchorInboundCount).toBe(1);
  });

  it("rejects a context without a transactions array", () => {
    const provider = createAnchorAnomalyFeatureProvider({ anchorAssetCodes: ["USD"] });
    expect(() =>
      provider.compute({} as never)
    ).toThrow();
  });
});
