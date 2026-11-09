/**
 * Tests for dusting feature extraction (issue #28).
 */

import { describe, it, expect } from "vitest";
import type { Transaction } from "../clients/horizon.js";
import { ValidationError } from "../errors.js";
import {
  DEFAULT_DUST_THRESHOLD,
  extractDustingFeatures,
  dustingFeaturesToFeatureMap,
  createDustingFeatureProvider,
} from "./dusting.js";

const ACCOUNT = "GACCOUNT00000000000000000000000000000000000000000000000000";

let nextId = 0;
function payment(overrides: Partial<Transaction> = {}): Transaction {
  nextId += 1;
  return {
    id: `p-${nextId}`,
    createdAt: "2026-01-01T12:00:00.000Z",
    sourceAccount: ACCOUNT,
    type: "payment",
    amount: 0.0001,
    from: ACCOUNT,
    to: `GRCPT${String(nextId).padStart(52, "0")}`,
    assetCode: "XLM",
    pagingToken: String(nextId),
    ...overrides,
  };
}

describe("extractDustingFeatures", () => {
  it("identifies outbound dust payments to distinct recipients", () => {
    const features = extractDustingFeatures(
      [
        payment({ amount: 0.0001, to: "GA" }),
        payment({ amount: 0.0002, to: "GB" }),
        payment({ amount: 0.0001, to: "GC" }),
        payment({ amount: 1, to: "GD" }), // above threshold
      ],
      { accountId: ACCOUNT, dustThreshold: 0.01 }
    );

    expect(features.dustPaymentCount).toBe(3);
    expect(features.dustRecipientCount).toBe(3);
    expect(features.dustTotalVolume).toBeCloseTo(0.0004);
    expect(features.dustAssetDiversity).toBe(1);
    expect(features.outboundPaymentCount).toBe(4);
    expect(features.dustingScore).toBeGreaterThan(0);
    expect(features.dustThreshold).toBe(0.01);
  });

  it("ignores inbound and non-payment operations", () => {
    const features = extractDustingFeatures(
      [
        payment({ from: "GOTHER", sourceAccount: "GOTHER", to: ACCOUNT, amount: 0.0001 }),
        { ...payment({ amount: 0.0001 }), type: "create_account" },
      ],
      { accountId: ACCOUNT }
    );

    expect(features.dustPaymentCount).toBe(0);
    expect(features.dustRecipientCount).toBe(0);
    expect(features.outboundPaymentCount).toBe(0);
  });

  it("yields zeroed features for empty history", () => {
    const features = extractDustingFeatures([], { accountId: ACCOUNT });
    expect(features.dustPaymentCount).toBe(0);
    expect(features.dustRecipientCount).toBe(0);
    expect(features.dustingScore).toBe(0);
  });

  it("honors a custom dust threshold", () => {
    const txs = [
      payment({ amount: 0.005, to: "GA" }),
      payment({ amount: 0.02, to: "GB" }),
    ];
    expect(extractDustingFeatures(txs, { accountId: ACCOUNT, dustThreshold: 0.001 }).dustPaymentCount).toBe(0);
    expect(extractDustingFeatures(txs, { accountId: ACCOUNT, dustThreshold: 0.01 }).dustPaymentCount).toBe(1);
    expect(extractDustingFeatures(txs, { accountId: ACCOUNT, dustThreshold: 0.1 }).dustPaymentCount).toBe(2);
  });

  it("reports asset diversity across dust payments", () => {
    const features = extractDustingFeatures(
      [
        payment({ amount: 0.0001, to: "GA", assetCode: "XLM" }),
        payment({ amount: 0.0001, to: "GB", assetCode: "USDC", assetIssuer: "GISSUER" }),
      ],
      { accountId: ACCOUNT }
    );
    expect(features.dustAssetDiversity).toBe(2);
  });

  it("rejects invalid options", () => {
    expect(() => extractDustingFeatures([], {})).toThrow(ValidationError);
    expect(() => extractDustingFeatures([], { accountId: "  " })).toThrow(ValidationError);
    expect(() => extractDustingFeatures([], { accountId: ACCOUNT, dustThreshold: 0 })).toThrow(ValidationError);
    expect(() => extractDustingFeatures(null as never, { accountId: ACCOUNT })).toThrow(ValidationError);
  });

  it("exports the default dust threshold", () => {
    expect(DEFAULT_DUST_THRESHOLD).toBeGreaterThan(0);
  });
});

describe("dustingFeaturesToFeatureMap and provider", () => {
  it("flattens features", () => {
    const map = dustingFeaturesToFeatureMap(
      extractDustingFeatures([payment({ to: "GA" })], { accountId: ACCOUNT })
    );
    expect(map.dustPaymentCount).toBe(1);
    expect(map.dustRecipientCount).toBe(1);
    expect(typeof map.dustingScore).toBe("number");
  });

  it("provider uses context account id", () => {
    const provider = createDustingFeatureProvider({ dustThreshold: 0.01 });
    const map = provider.compute({
      accountId: ACCOUNT,
      transactions: [payment({ amount: 0.0001, to: "GA" })],
    });
    expect(provider.name).toBe("dusting");
    expect(map.dustPaymentCount).toBe(1);
  });

  it("provider rejects missing account id", () => {
    const provider = createDustingFeatureProvider();
    expect(() => provider.compute({ transactions: [] })).toThrow(ValidationError);
  });
});
