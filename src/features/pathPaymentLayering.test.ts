/**
 * Tests for path-payment layering features (issue #26).
 *
 * Covers identification/parsing of path payments, long hop chains,
 * circular paths/flows, rapid successive payments, and no-path cases.
 */

import { describe, it, expect } from "vitest";
import type { Transaction } from "../clients/horizon.js";
import { ValidationError } from "../errors.js";
import {
  extractPathPaymentLayeringFeatures,
  getPathHopCount,
  hasCircularPath,
  isPathPaymentTransaction,
  pathPaymentLayeringFeaturesToFeatureMap,
  createPathPaymentLayeringFeatureProvider,
} from "./pathPaymentLayering.js";

const REFERENCE = "2026-01-01T12:00:00.000Z";
const REFERENCE_MS = Date.parse(REFERENCE);
const A = "GA";
const B = "GB";
const C = "GC";
const D = "GD";

let nextId = 0;
function tx(overrides: Partial<Transaction> & { path?: Transaction["path"] } = {}): Transaction {
  nextId += 1;
  return {
    id: `pp-${nextId}`,
    createdAt: REFERENCE,
    sourceAccount: A,
    type: "payment",
    amount: 10,
    assetCode: "XLM",
    from: A,
    to: B,
    pagingToken: String(nextId),
    ...overrides,
  };
}

function pathPayment(
  overrides: Partial<Transaction> & { path?: Transaction["path"] } = {}
): Transaction {
  return tx({
    type: "path_payment_strict_send",
    from: A,
    to: B,
    ...overrides,
  });
}

function minutesAgo(minutes: number): string {
  return new Date(REFERENCE_MS - minutes * 60_000).toISOString();
}

describe("path payment identification and parsing", () => {
  it("identifies strict_send and strict_receive path payments", () => {
    expect(
      isPathPaymentTransaction(pathPayment({ type: "path_payment_strict_send" }))
    ).toBe(true);
    expect(
      isPathPaymentTransaction(pathPayment({ type: "path_payment_strict_receive" }))
    ).toBe(true);
    expect(isPathPaymentTransaction(tx({ type: "payment" }))).toBe(false);
  });

  it("parses hop count from intermediate path assets", () => {
    expect(getPathHopCount(pathPayment({ path: [] }))).toBe(0);
    expect(
      getPathHopCount(
        pathPayment({
          path: [{ asset_code: "USD", asset_issuer: "I1" }],
        })
      )
    ).toBe(1);
    expect(
      getPathHopCount(
        pathPayment({
          path: [
            { asset_code: "USD", asset_issuer: "I1" },
            { asset_code: "EUR", asset_issuer: "I2" },
            { asset_code: "BTC", asset_issuer: "I3" },
          ],
        })
      )
    ).toBe(3);
  });
});

describe("extractPathPaymentLayeringFeatures - no-path cases", () => {
  it("returns zeroed features for an empty history", () => {
    const features = extractPathPaymentLayeringFeatures([], { now: REFERENCE });
    expect(features).toMatchObject({
      pathPaymentCount: 0,
      maxHopCount: 0,
      longChainCount: 0,
      circularPathCount: 0,
      rapidSuccessiveCount: 0,
      hasCircularFlow: false,
      layeringScore: 0,
    });
  });

  it("ignores non-path-payment transactions", () => {
    const features = extractPathPaymentLayeringFeatures(
      [tx({ type: "payment" }), tx({ type: "create_account" })],
      { now: REFERENCE }
    );
    expect(features.pathPaymentCount).toBe(0);
    expect(features.layeringScore).toBe(0);
  });
});

describe("extractPathPaymentLayeringFeatures - simple case", () => {
  it("detects a simple path payment with a short path", () => {
    const features = extractPathPaymentLayeringFeatures(
      [
        pathPayment({
          path: [{ asset_code: "USD", asset_issuer: "I1" }],
        }),
      ],
      { now: REFERENCE }
    );
    expect(features.pathPaymentCount).toBe(1);
    expect(features.maxHopCount).toBe(1);
    expect(features.longChainCount).toBe(0);
    expect(features.circularPathCount).toBe(0);
  });
});

describe("extractPathPaymentLayeringFeatures - long chains", () => {
  it("flags long-chained hop paths and scales with hop count", () => {
    const features = extractPathPaymentLayeringFeatures(
      [
        pathPayment({
          path: [
            { asset_code: "USD", asset_issuer: "I1" },
            { asset_code: "EUR", asset_issuer: "I2" },
            { asset_code: "BTC", asset_issuer: "I3" },
            { asset_code: "JPY", asset_issuer: "I4" },
          ],
        }),
      ],
      { now: REFERENCE, longChainHops: 2 }
    );
    expect(features.pathPaymentCount).toBe(1);
    expect(features.maxHopCount).toBe(4);
    expect(features.longChainCount).toBe(1);
    expect(features.layeringScore).toBeGreaterThan(0);
  });
});

describe("extractPathPaymentLayeringFeatures - circular cases", () => {
  it("detects a circular hop chain when an intermediate asset repeats", () => {
    expect(
      hasCircularPath(
        pathPayment({
          path: [
            { asset_code: "USD", asset_issuer: "I1" },
            { asset_code: "EUR", asset_issuer: "I2" },
            { asset_code: "USD", asset_issuer: "I1" },
          ],
        })
      )
    ).toBe(true);

    const features = extractPathPaymentLayeringFeatures(
      [
        pathPayment({
          path: [
            { asset_code: "USD", asset_issuer: "I1" },
            { asset_code: "EUR", asset_issuer: "I2" },
            { asset_code: "USD", asset_issuer: "I1" },
          ],
        }),
      ],
      { now: REFERENCE }
    );
    expect(features.circularPathCount).toBe(1);
  });

  it("detects circular counterparty flow across path payments", () => {
    const features = extractPathPaymentLayeringFeatures(
      [
        pathPayment({ id: "p1", from: A, to: B, path: [{ asset_code: "U", asset_issuer: "I" }] }),
        pathPayment({ id: "p2", from: B, to: C, path: [{ asset_code: "U", asset_issuer: "I" }] }),
        pathPayment({ id: "p3", from: C, to: A, path: [{ asset_code: "U", asset_issuer: "I" }] }),
      ],
      { now: REFERENCE }
    );
    expect(features.hasCircularFlow).toBe(true);
    expect(features.layeringScore).toBeGreaterThan(0);
  });
});

describe("extractPathPaymentLayeringFeatures - rapid successive", () => {
  it("counts rapid successive path payments and scales with frequency", () => {
    const features = extractPathPaymentLayeringFeatures(
      [
        pathPayment({ createdAt: minutesAgo(10), path: [{ asset_code: "U", asset_issuer: "I" }] }),
        pathPayment({ createdAt: minutesAgo(8), path: [{ asset_code: "U", asset_issuer: "I" }] }),
        pathPayment({ createdAt: minutesAgo(5), path: [{ asset_code: "U", asset_issuer: "I" }] }),
      ],
      { now: REFERENCE, rapidWindowMs: 60 * 60 * 1000 }
    );
    expect(features.pathPaymentCount).toBe(3);
    expect(features.rapidSuccessiveCount).toBeGreaterThan(0);
    expect(features.layeringScore).toBeGreaterThan(0);
  });
});

describe("pathPaymentLayering provider and mapping", () => {
  it("flattens features into the registry map", () => {
    const map = pathPaymentLayeringFeaturesToFeatureMap({
      pathPaymentCount: 2,
      maxHopCount: 3,
      longChainCount: 1,
      circularPathCount: 0,
      rapidSuccessiveCount: 2,
      hasCircularFlow: false,
      layeringScore: 0.42,
    });
    expect(map).toMatchObject({
      pathPaymentCount: 2,
      pathPaymentMaxHops: 3,
      pathPaymentLongChainCount: 1,
      pathPaymentCircularCount: 0,
      pathPaymentRapidCount: 2,
      pathPaymentHasCircularFlow: false,
      pathPaymentLayeringScore: 0.42,
    });
  });

  it("creates a registry-ready provider", () => {
    const provider = createPathPaymentLayeringFeatureProvider({ now: REFERENCE });
    expect(provider.name).toBe("pathPaymentLayering");
    const map = provider.compute({
      transactions: [pathPayment({ path: [{ asset_code: "U", asset_issuer: "I" }] })],
      now: REFERENCE,
    });
    expect(map.pathPaymentCount).toBe(1);
  });

  it("validates input", () => {
    expect(() => extractPathPaymentLayeringFeatures(null as never)).toThrow(ValidationError);
  });
});
