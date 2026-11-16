/**
 * Tests for the multisig authorization-change feature extractor (#35).
 *
 * Acceptance criteria: relevant `set_options` changes are detected
 * (signers, thresholds, master weight, clawback and auth flags);
 * suspicious changes feed the detector; computation is deterministic;
 * empty histories yield zeroed features.
 */

import { describe, it, expect } from "vitest";
import type { Transaction } from "../clients/horizon.js";
import {
  normalizeSetOptions,
  normalizeTransaction,
} from "../clients/horizon.js";
import {
  extractMultisigAuthFeatures,
  multisigAuthFeaturesToFeatureMap,
  createMultisigAuthFeatureProvider,
  SET_OPTIONS_TYPES,
  AUTH_FLAGS,
  CLAWBACK_ENABLED_FLAG,
} from "./multisigAuth.js";

const ACCOUNT =
  "GACCOUNT00000000000000000000000000000000000000000000000000";

let nextId = 0;
function makeTx(overrides: Partial<Transaction> = {}): Transaction {
  nextId += 1;
  return {
    id: `multisig-tx-${nextId}`,
    createdAt: "2026-01-01T12:00:00.000Z",
    sourceAccount: ACCOUNT,
    type: "set_options",
    amount: 0,
    assetCode: "XLM",
    pagingToken: String(nextId),
    ...overrides,
  };
}

describe("normalizeSetOptions (clients/horizon)", () => {
  it("normalizes a wire-shaped set_options object", () => {
    const details = normalizeSetOptions({
      signer: { key: "GSIGNER", weight: 0, type: "ed25519_public_key" },
      master_weight: "10",
      low_threshold: 1,
      med_threshold: 2,
      high_threshold: 3,
      set_flags: [8],
      clear_flags: ["auth_revocable"],
    });

    expect(details?.signers).toEqual([
      { key: "GSIGNER", weight: 0, type: "ed25519_public_key" },
    ]);
    expect(details?.masterWeight).toBe(10);
    expect(details?.thresholds).toEqual({ low: 1, medium: 2, high: 3 });
    expect(details?.setFlags).toEqual(["clawback_enabled"]);
    expect(details?.clearFlags).toEqual(["auth_revocable"]);
  });

  it("normalizes an enriched friendlier shape", () => {
    const details = normalizeSetOptions({
      signers: [
        { key: "A", weight: 1 },
        { key: "B", weight: 0 },
      ],
      masterWeight: 5,
      thresholds: { low: 0, medium: 1, high: 2 },
      previousThresholds: { low: 0, medium: 3, high: 4 },
      previousMasterWeight: 9,
      setFlags: ["AUTH_REQUIRED"],
    });

    expect(details?.signers).toHaveLength(2);
    expect(details?.thresholds).toEqual({ low: 0, medium: 1, high: 2 });
    expect(details?.previousThresholds).toEqual({ low: 0, medium: 3, high: 4 });
    expect(details?.previousMasterWeight).toBe(9);
    expect(details?.setFlags).toEqual(["auth_required"]);
  });

  it("returns undefined for empty or unusable input", () => {
    expect(normalizeSetOptions(undefined)).toBeUndefined();
    expect(normalizeSetOptions(null)).toBeUndefined();
    expect(normalizeSetOptions("junk")).toBeUndefined();
    expect(normalizeSetOptions({})).toBeUndefined();
    expect(normalizeSetOptions({ signers: [123] })).toBeUndefined();
  });

  it("maps numeric flag bitmasks to names and keeps unknowns", () => {
    const details = normalizeSetOptions({ set_flags: [1, 2, 4, 8, 64] });
    expect(details?.setFlags).toEqual([
      "auth_required",
      "auth_revocable",
      "auth_immutable",
      "clawback_enabled",
      "flag_64",
    ]);
  });

  it("is wired into normalizeTransaction", () => {
    const tx = normalizeTransaction({
      id: "t-so-1",
      type: "set_options",
      source_account: ACCOUNT,
      paging_token: "1",
      created_at: "2026-06-01T00:00:00Z",
      set_options: {
        master_weight: 3,
        set_flags: [8],
      },
    });

    expect(tx.setOptions?.masterWeight).toBe(3);
    expect(tx.setOptions?.setFlags).toEqual(["clawback_enabled"]);
  });
});

describe("extractMultisigAuthFeatures - signers", () => {
  it("counts signer additions and removals", () => {
    const txs = [
      makeTx({
        setOptions: { signers: [{ key: "GSIGN1", weight: 1 }] },
      }),
      makeTx({
        setOptions: {
          signers: [
            { key: "GSIGN2", weight: 0 },
            { key: "GSIGN3", weight: 0 },
          ],
        },
      }),
      makeTx({ type: "payment" }),
    ];
    const features = extractMultisigAuthFeatures(txs);

    expect(features.setOptionsCount).toBe(2);
    expect(features.signerOperationCount).toBe(2);
    expect(features.signerAddedCount).toBe(1);
    expect(features.signerRemovedCount).toBe(2);
  });

  it("tolerates set_options transactions without enriched details", () => {
    const txs = [makeTx(), makeTx({ setOptions: undefined })];
    const features = extractMultisigAuthFeatures(txs);

    expect(features.setOptionsCount).toBe(2);
    expect(features.signerAddedCount).toBe(0);
    expect(features.signerRemovedCount).toBe(0);
  });
});

describe("extractMultisigAuthFeatures - thresholds", () => {
  it("counts threshold changes without previous values", () => {
    const txs = [
      makeTx({ setOptions: { thresholds: { low: 0, medium: 1, high: 2 } } }),
    ];
    const features = extractMultisigAuthFeatures(txs);

    expect(features.thresholdChangeCount).toBe(1);
    expect(features.thresholdReductionCount).toBe(0);
    expect(features.thresholdIncreaseCount).toBe(0);
  });

  it("detects threshold reductions when previous values are known", () => {
    const txs = [
      makeTx({
        setOptions: {
          thresholds: { low: 0, medium: 1, high: 2 },
          previousThresholds: { low: 1, medium: 3, high: 4 },
        },
      }),
    ];
    const features = extractMultisigAuthFeatures(txs);

    expect(features.thresholdReductionCount).toBe(1);
    expect(features.thresholdIncreaseCount).toBe(0);
  });

  it("detects threshold increases when nothing decreased", () => {
    const txs = [
      makeTx({
        setOptions: {
          thresholds: { low: 1, medium: 3, high: 4 },
          previousThresholds: { low: 0, medium: 2, high: 4 },
        },
      }),
    ];
    const features = extractMultisigAuthFeatures(txs);

    expect(features.thresholdIncreaseCount).toBe(1);
    expect(features.thresholdReductionCount).toBe(0);
  });

  it("detects master weight reductions when previous value is known", () => {
    const txs = [
      makeTx({
        setOptions: { masterWeight: 1, previousMasterWeight: 5 },
      }),
      makeTx({
        setOptions: { masterWeight: 7 },
      }),
    ];
    const features = extractMultisigAuthFeatures(txs);

    expect(features.masterWeightChangeCount).toBe(2);
    expect(features.masterWeightReductionCount).toBe(1);
  });
});

describe("extractMultisigAuthFeatures - flags", () => {
  it("counts clawback enablement and authorization flag changes", () => {
    const txs = [
      makeTx({ setOptions: { setFlags: [CLAWBACK_ENABLED_FLAG] } }),
      makeTx({ setOptions: { clearFlags: [CLAWBACK_ENABLED_FLAG] } }),
      makeTx({ setOptions: { setFlags: [AUTH_FLAGS[0], "something_else"] } }),
    ];
    const features = extractMultisigAuthFeatures(txs);

    expect(features.clawbackEnabledCount).toBe(1);
    expect(features.clawbackDisabledCount).toBe(1);
    expect(features.authFlagChangeCount).toBe(1);
  });

  it("counts a flag flip affecting both sets at most once per operation", () => {
    const txs = [
      makeTx({ setOptions: { setFlags: ["auth_revocable"], clearFlags: [] } }),
    ];
    const features = extractMultisigAuthFeatures(txs);

    expect(features.authFlagChangeCount).toBe(1);
  });
});

describe("extractMultisigAuthFeatures - contract", () => {
  it("yields zeroed features for an empty history", () => {
    const features = extractMultisigAuthFeatures([]);

    expect(features.setOptionsCount).toBe(0);
    expect(features.signerAddedCount).toBe(0);
    expect(features.thresholdReductionCount).toBe(0);
    expect(features.clawbackEnabledCount).toBe(0);
  });

  it("ignores non-set_options transactions and non-object entries", () => {
    const txs = [
      makeTx({ type: "payment", setOptions: { masterWeight: 1 } }),
      makeTx({ type: "SET_OPTIONS" }),
      null,
      undefined,
    ] as unknown as Transaction[];
    const features = extractMultisigAuthFeatures(txs);

    // "SET_OPTIONS" is matched case-insensitively; payment is not.
    expect(features.setOptionsCount).toBe(1);
  });

  it("rejects a non-array history", () => {
    expect(() =>
      extractMultisigAuthFeatures("nope" as unknown as Transaction[])
    ).toThrow();
  });

  it("exposes the set_options type list", () => {
    expect(SET_OPTIONS_TYPES).toContain("set_options");
    expect(AUTH_FLAGS).toEqual(["auth_required", "auth_revocable", "auth_immutable"]);
  });

  it("is deterministic for identical input", () => {
    const txs = [
      makeTx({ setOptions: { signers: [{ key: "A", weight: 0 }] } }),
      makeTx({ setOptions: { setFlags: ["clawback_enabled"] } }),
    ];
    const a = extractMultisigAuthFeatures(txs);
    const b = extractMultisigAuthFeatures(txs);

    expect(a).toEqual(b);
  });
});

describe("multisigAuthFeaturesToFeatureMap", () => {
  it("exports all scalar feature values", () => {
    const map = multisigAuthFeaturesToFeatureMap(
      extractMultisigAuthFeatures([
        makeTx({ setOptions: { signers: [{ key: "A", weight: 0 }] } }),
      ])
    );

    for (const key of [
      "setOptionsCount",
      "signerOperationCount",
      "signerAddedCount",
      "signerRemovedCount",
      "thresholdChangeCount",
      "thresholdReductionCount",
      "thresholdIncreaseCount",
      "masterWeightChangeCount",
      "masterWeightReductionCount",
      "clawbackEnabledCount",
      "clawbackDisabledCount",
      "authFlagChangeCount",
    ]) {
      expect(typeof map[key]).toBe("number");
    }
    expect(map.signerRemovedCount).toBe(1);
  });
});

describe("createMultisigAuthFeatureProvider", () => {
  it("computes from the shared feature context", () => {
    const provider = createMultisigAuthFeatureProvider();
    const map = provider.compute({
      accountId: ACCOUNT,
      transactions: [makeTx({ setOptions: { signers: [{ key: "A", weight: 0 }] } })],
    });

    expect(provider.name).toBe("multisig-auth");
    expect(map.setOptionsCount).toBe(1);
    expect(map.signerRemovedCount).toBe(1);
  });

  it("rejects a context without a transactions array", () => {
    const provider = createMultisigAuthFeatureProvider();
    expect(() => provider.compute({} as never)).toThrow();
  });
});
