/**
 * Tests for the feature registry (issue #24).
 *
 * Covers the five default families running through one pipeline, the
 * merged uniform map, per-provider toggling via config and at runtime,
 * deterministic merge order, and validation failures.
 */

import { describe, it, expect } from "vitest";
import type { Account, Transaction } from "../clients/horizon.js";
import { ValidationError } from "../errors.js";
import type { FeatureContext } from "./types.js";
import {
  FeatureRegistry,
  createDefaultFeatureProviders,
  createDefaultFeatureRegistry,
  createFeatureRegistry,
  extractFeatures,
} from "./registry.js";

const ACCOUNT = "GABCDEFGHIJKLMNOPQRSTUVWXYZABCDEFGHIJKLMNOPQRSTUVWXYZABCDEF";
const OTHER = "GZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ";
const REFERENCE = "2026-01-01T12:00:00.000Z";
const REFERENCE_MS = Date.parse(REFERENCE);

function minutesAgo(minutes: number): string {
  return new Date(REFERENCE_MS - minutes * 60_000).toISOString();
}

let nextId = 0;

function makeTx(overrides: Partial<Transaction> = {}): Transaction {
  nextId += 1;
  return {
    id: `tx-${nextId}`,
    createdAt: REFERENCE,
    sourceAccount: ACCOUNT,
    type: "payment",
    amount: 1,
    assetCode: "XLM",
    ledger: 100 + nextId,
    pagingToken: String(nextId),
    ...overrides,
  };
}

function makeAccount(id: string = ACCOUNT): Account {
  return {
    id,
    sequence: 1,
    sequenceString: "1",
    signatureThreshold: 2,
    subentryCount: 0,
    thresholds: { low: 0, medium: 2, high: 2 },
    balances: [
      {
        code: "XLM",
        type: "native",
        amount: 100,
        clawbackEnabled: false,
        authorized: true,
      },
    ],
    signers: [],
    data: {},
    lastLedger: 120,
    pagingToken: "1",
  };
}

function makeContext(overrides: Partial<FeatureContext> = {}): FeatureContext {
  return {
    accountId: ACCOUNT,
    account: makeAccount(),
    transactions: [
      makeTx({ createdAt: minutesAgo(5), to: OTHER, ledger: 101 }),
      makeTx({ createdAt: minutesAgo(30), from: OTHER, ledger: 102 }),
    ],
    now: REFERENCE,
    ...overrides,
  };
}

describe("FeatureRegistry", () => {
  it("registers all five feature families and runs them through the pipeline", () => {
    const registry = createDefaultFeatureRegistry();

    expect(registry.providerNames()).toEqual([
      "velocity",
      "graph",
      "assets",
      "memo",
      "lifecycle",
    ]);

    const map = registry.compute(makeContext());

    // One key from each family proves every provider ran.
    expect(map["txCount1h"]).toBe(2);
    expect(map["graphOutDegree"]).toBe(1);
    expect(map["assetTrustlineCount"]).toBe(0);
    expect(map["memoTotalCount"]).toBe(2);
    expect(map["lifecycleTransactionCount"]).toBe(2);
  });

  it("produces a uniform FeatureMap for downstream models", () => {
    const registry = createDefaultFeatureRegistry();
    const map = registry.compute(makeContext({ transactions: [] }));

    expect(typeof map).toBe("object");
    expect(map["txCount1h"]).toBe(0);
    expect(map["graphOutDegree"]).toBe(0);
    expect(map["assetBalanceCount"]).toBe(1);
    expect(map["memoTotalCount"]).toBe(0);
    expect(map["accountAgeMs"]).toBe(0);
  });

  it("is deterministic: identical context yields identical output", () => {
    const registry = createDefaultFeatureRegistry();
    const context = makeContext();

    expect(registry.compute(context)).toEqual(registry.compute(context));
    expect(registry.extract(context)).toEqual(registry.compute(context));
  });

  it("merges in registration order with later providers winning", () => {
    const registry = createFeatureRegistry({
      providers: [
        { name: "first", compute: () => ({ shared: "first", onlyFirst: 1 }) },
        { name: "second", compute: () => ({ shared: "second", onlySecond: 2 }) },
      ],
    });

    expect(registry.compute({ transactions: [] })).toEqual({
      shared: "second",
      onlyFirst: 1,
      onlySecond: 2,
    });
  });

  it("toggles providers via config", () => {
    const registry = createDefaultFeatureRegistry({
      enabled: { graph: false },
    });

    expect(registry.isEnabled("graph")).toBe(false);
    expect(registry.isEnabled("velocity")).toBe(true);

    const map = registry.compute(makeContext());
    expect(map["graphOutDegree"]).toBeUndefined();
    expect(map["txCount1h"]).toBe(2);
  });

  it("toggles providers at runtime with setEnabled", () => {
    const registry = createDefaultFeatureRegistry();
    expect(registry.enabledProviders()).toHaveLength(5);

    registry.setEnabled("memo", false);
    expect(registry.isEnabled("memo")).toBe(false);
    expect(registry.enabledProviders()).toHaveLength(4);

    const map = registry.compute(makeContext());
    expect(map["memoTotalCount"]).toBeUndefined();
    expect(map["txCount1h"]).toBe(2);

    registry.setEnabled("memo", true);
    expect(registry.compute(makeContext())["memoTotalCount"]).toBe(2);
  });

  it("supports custom providers alongside the defaults", () => {
    const custom = {
      name: "custom-signal",
      compute: () => ({ customFeature: 42 }),
    };

    const registry = createDefaultFeatureRegistry();
    registry.register(custom);

    expect(registry.has("custom-signal")).toBe(true);
    expect(registry.get("custom-signal")).toBe(custom);
    expect(registry.compute(makeContext())["customFeature"]).toBe(42);
    expect(registry.unregister("custom-signal")).toBe(true);
    expect(registry.compute(makeContext())["customFeature"]).toBeUndefined();
  });

  it("skips disabled providers so their failures do not surface", () => {
    const registry = createFeatureRegistry({
      providers: [
        { name: "bad", compute: () => { throw new Error("boom"); } },
        { name: "good", compute: () => ({ goodFeature: 1 }) },
      ],
      enabled: { bad: false },
    });

    expect(registry.compute({ transactions: [] })).toEqual({ goodFeature: 1 });
  });

  it("propagates provider errors unchanged (fail fast)", () => {
    const failure = new Error("provider blew up");
    const registry = createFeatureRegistry({
      providers: [{ name: "bad", compute: () => { throw failure; } }],
    });

    expect(() => registry.compute({ transactions: [] })).toThrow(failure);
  });

  it("exposes list, get, and has helpers", () => {
    const registry = createDefaultFeatureRegistry();

    expect(registry.list()).toHaveLength(5);
    expect(registry.has("velocity")).toBe(true);
    expect(registry.has("nope")).toBe(false);
    expect(registry.get("velocity")?.name).toBe("velocity");
    expect(registry.get("nope")).toBeUndefined();
    expect(createDefaultFeatureProviders()).toHaveLength(5);
  });
});

describe("FeatureRegistry validation", () => {
  it("rejects duplicate provider names", () => {
    const provider = { name: "dup", compute: () => ({}) };
    expect(() =>
      createFeatureRegistry({ providers: [provider, { ...provider }] })
    ).toThrow(ValidationError);

    const registry = createFeatureRegistry({ providers: [provider] });
    expect(() => registry.register({ ...provider })).toThrow(ValidationError);
  });

  it("rejects malformed providers", () => {
    expect(() =>
      createFeatureRegistry({ providers: [{ compute: () => ({}) } as never] })
    ).toThrow(ValidationError);
    expect(() =>
      createFeatureRegistry({
        providers: [{ name: "x", compute: null } as never],
      })
    ).toThrow(ValidationError);
  });

  it("rejects an unknown name in the enabled config", () => {
    expect(() =>
      createDefaultFeatureRegistry({ enabled: { unknown: true } })
    ).toThrow(/Unknown feature provider "unknown"/);
  });

  it("rejects a non-boolean enabled value", () => {
    expect(() =>
      createDefaultFeatureRegistry({ enabled: { velocity: "no" as never } })
    ).toThrow(ValidationError);
  });

  it("rejects unknown names and non-booleans in setEnabled/isEnabled", () => {
    const registry = createDefaultFeatureRegistry();
    expect(() => registry.setEnabled("nope", true)).toThrow(ValidationError);
    expect(() => registry.setEnabled("velocity", "x" as never)).toThrow(
      ValidationError
    );
    expect(() => registry.isEnabled("nope")).toThrow(ValidationError);
  });

  it("rejects a malformed FeatureContext", () => {
    const registry = createDefaultFeatureRegistry();
    expect(() =>
      registry.compute(null as never)
    ).toThrow(ValidationError);
    expect(() =>
      registry.compute({ transactions: null } as never)
    ).toThrow(ValidationError);
  });

  it("rejects a provider that returns a non-object map", () => {
    const registry = createFeatureRegistry({
      providers: [{ name: "bad", compute: () => null as never }],
    });
    expect(() => registry.compute({ transactions: [] })).toThrow(ValidationError);
  });
});

describe("extractFeatures helper", () => {
  it("extracts with the default registry when none is supplied", () => {
    const map = extractFeatures(makeContext());
    expect(map["txCount1h"]).toBe(2);
    expect(map["memoTotalCount"]).toBe(2);
  });

  it("extracts with a supplied registry", () => {
    const registry = createDefaultFeatureRegistry({ enabled: { memo: false } });
    const map = extractFeatures(makeContext(), registry);
    expect(map["memoTotalCount"]).toBeUndefined();
    expect(map["txCount1h"]).toBe(2);
  });
});
