/**
 * Tests for counterparty graph construction and graph features (#20).
 *
 * Covers construction/queries, known topologies (star, chain, ring),
 * directed vs undirected views, bounds, and the registry-ready provider.
 */

import { describe, it, expect } from "vitest";
import type { Transaction } from "../clients/horizon.js";
import { ValidationError } from "../errors.js";
import {
  CounterpartyGraph,
  buildCounterpartyGraph,
  createGraphFeatureProvider,
  extractGraphFeatures,
} from "./graph.js";

let nextId = 0;

function makeTx(
  from: string | undefined,
  to: string | undefined,
  overrides: Partial<Transaction> = {}
): Transaction {
  nextId += 1;
  return {
    id: `tx-${nextId}`,
    createdAt: "2026-01-01T00:00:00.000Z",
    sourceAccount: from ?? "GSELF",
    type: "payment",
    amount: 1,
    assetCode: "XLM",
    from,
    to,
    ledger: nextId,
    pagingToken: String(nextId),
    ...overrides,
  };
}

describe("CounterpartyGraph", () => {
  it("supports directed and undirected neighbor queries", () => {
    const graph = new CounterpartyGraph();
    expect(graph.addEdge("A", "B")).toBe(true);
    expect(graph.addEdge("B", "C")).toBe(true);

    expect(graph.nodeCount).toBe(3);
    expect(graph.edgeCount).toBe(2);
    expect(graph.outNeighbors("B")).toEqual(["C"]);
    expect(graph.inNeighbors("B")).toEqual(["A"]);
    expect(graph.neighbors("B")).toEqual(["A", "C"]);
    expect(graph.outDegree("B")).toBe(1);
    expect(graph.inDegree("B")).toBe(1);
    expect(graph.degree("B")).toBe(2);
  });

  it("ignores self-loops, duplicates, and empty identifiers", () => {
    const graph = new CounterpartyGraph();
    expect(graph.addEdge("A", "A")).toBe(false);
    expect(graph.addEdge("", "B")).toBe(false);
    expect(graph.addEdge("A", "B")).toBe(true);
    expect(graph.addEdge("A", "B")).toBe(true);

    expect(graph.nodeCount).toBe(2);
    expect(graph.edgeCount).toBe(1);
    expect(graph.outDegree("A")).toBe(1);
  });

  it("rejects invalid bounds", () => {
    expect(() => new CounterpartyGraph({ maxNodes: 0 })).toThrow(ValidationError);
    expect(() => new CounterpartyGraph({ maxEdges: -1 })).toThrow(ValidationError);
    expect(() => new CounterpartyGraph({ maxNodes: Number.NaN })).toThrow(
      ValidationError
    );
  });
});

describe("buildCounterpartyGraph", () => {
  it("builds edges from transaction counterparties", () => {
    const graph = buildCounterpartyGraph([
      makeTx("A", "B"),
      makeTx("B", "C"),
      makeTx(undefined, "D", { sourceAccount: "C" }),
    ]);

    expect(graph.nodeCount).toBe(4);
    expect(graph.edgeCount).toBe(3);
    expect(graph.outNeighbors("C")).toEqual(["D"]);
  });

  it("skips transactions without a recipient", () => {
    const graph = buildCounterpartyGraph([makeTx("A", undefined)]);
    expect(graph.nodeCount).toBe(0);
    expect(graph.edgeCount).toBe(0);
  });

  it("caps nodes and flags truncation", () => {
    const graph = buildCounterpartyGraph(
      [makeTx("A", "B"), makeTx("B", "C"), makeTx("C", "D")],
      { maxNodes: 3 }
    );

    expect(graph.nodeCount).toBe(3);
    expect(graph.edgeCount).toBe(2);
    expect(graph.hasNode("D")).toBe(false);
    expect(graph.truncated).toBe(true);
  });

  it("caps edges and flags truncation", () => {
    const graph = buildCounterpartyGraph(
      [makeTx("A", "B"), makeTx("C", "D")],
      { maxEdges: 1 }
    );

    expect(graph.edgeCount).toBe(1);
    expect(graph.truncated).toBe(true);
  });
});

describe("extractGraphFeatures topologies", () => {
  it("computes star topology features (hub with no leaf-leaf edges)", () => {
    const leaves = ["L1", "L2", "L3", "L4"];
    const graph = buildCounterpartyGraph(leaves.map((leaf) => makeTx("CENTER", leaf)));

    expect(extractGraphFeatures(graph, "CENTER")).toMatchObject({
      outDegree: 4,
      inDegree: 0,
      totalDegree: 4,
      uniqueCounterparties: 4,
      clusteringCoefficient: 0,
      reachableAccounts: 4,
    });

    expect(extractGraphFeatures(graph, "L1")).toMatchObject({
      outDegree: 0,
      inDegree: 1,
      totalDegree: 1,
      uniqueCounterparties: 1,
      clusteringCoefficient: 0,
      reachableAccounts: 0,
    });
  });

  it("computes chain topology features with multi-hop reachability", () => {
    const graph = buildCounterpartyGraph([
      makeTx("A", "B"),
      makeTx("B", "C"),
      makeTx("C", "D"),
    ]);

    expect(extractGraphFeatures(graph, "A")).toMatchObject({
      outDegree: 1,
      inDegree: 0,
      totalDegree: 1,
      uniqueCounterparties: 1,
      clusteringCoefficient: 0,
      reachableAccounts: 3,
    });
    expect(extractGraphFeatures(graph, "C")).toMatchObject({
      outDegree: 1,
      inDegree: 1,
      totalDegree: 2,
      uniqueCounterparties: 2,
      clusteringCoefficient: 0,
      reachableAccounts: 1,
    });
    expect(extractGraphFeatures(graph, "D")).toMatchObject({
      outDegree: 0,
      inDegree: 1,
      reachableAccounts: 0,
    });
  });

  it("computes a fully-clustered three-account ring", () => {
    const graph = buildCounterpartyGraph([
      makeTx("A", "B"),
      makeTx("B", "C"),
      makeTx("C", "A"),
    ]);

    for (const account of ["A", "B", "C"]) {
      expect(extractGraphFeatures(graph, account)).toMatchObject({
        outDegree: 1,
        inDegree: 1,
        totalDegree: 2,
        uniqueCounterparties: 2,
        clusteringCoefficient: 1,
        reachableAccounts: 2,
      });
    }
  });

  it("reports zero clustering for a four-account ring without chords", () => {
    const graph = buildCounterpartyGraph([
      makeTx("A", "B"),
      makeTx("B", "C"),
      makeTx("C", "D"),
      makeTx("D", "A"),
    ]);

    expect(extractGraphFeatures(graph, "A")).toMatchObject({
      uniqueCounterparties: 2,
      clusteringCoefficient: 0,
      reachableAccounts: 3,
    });
  });

  it("returns zeroed account features for an unknown account", () => {
    const graph = buildCounterpartyGraph([makeTx("A", "B")]);

    expect(extractGraphFeatures(graph, "MISSING")).toMatchObject({
      outDegree: 0,
      inDegree: 0,
      totalDegree: 0,
      uniqueCounterparties: 0,
      clusteringCoefficient: 0,
      reachableAccounts: 0,
      nodeCount: 2,
      edgeCount: 1,
    });
  });

  it("honors the reachability bound", () => {
    const graph = buildCounterpartyGraph([
      makeTx("A", "B"),
      makeTx("B", "C"),
      makeTx("C", "D"),
    ]);

    const features = extractGraphFeatures(graph, "A", { maxReachableNodes: 1 });
    expect(features.reachableAccounts).toBe(1);
  });

  it("skips clustering work above the hub cutoff", () => {
    const graph = buildCounterpartyGraph([
      makeTx("A", "B"),
      makeTx("B", "C"),
      makeTx("C", "A"),
    ]);

    const features = extractGraphFeatures(graph, "A", { maxClusteringDegree: 1 });
    expect(features.clusteringCoefficient).toBe(0);
  });
});

describe("createGraphFeatureProvider", () => {
  it("returns a registry-ready provider named graph", () => {
    const provider = createGraphFeatureProvider();
    expect(provider.name).toBe("graph");

    const map = provider.compute({
      accountId: "CENTER",
      transactions: [makeTx("CENTER", "L1"), makeTx("CENTER", "L2")],
    });

    expect(map).toMatchObject({
      graphOutDegree: 2,
      graphInDegree: 0,
      graphTotalDegree: 2,
      graphUniqueCounterparties: 2,
      graphClusteringCoefficient: 0,
      graphReachableAccounts: 2,
      graphNodeCount: 3,
      graphEdgeCount: 2,
      graphTruncated: false,
    });
  });

  it("requires an account id", () => {
    const provider = createGraphFeatureProvider();
    expect(() => provider.compute({ transactions: [] })).toThrow(ValidationError);
  });
});

describe("CounterpartyGraph cycle detection", () => {
  it("detects no cycle in a chain", () => {
    const graph = buildCounterpartyGraph([
      makeTx("A", "B"),
      makeTx("B", "C"),
      makeTx("C", "D"),
    ]);
    expect(graph.hasDirectedCycle()).toBe(false);
    expect(graph.hasDirectedCycleFrom("A")).toBe(false);
  });

  it("detects a directed ring cycle", () => {
    const graph = buildCounterpartyGraph([
      makeTx("A", "B"),
      makeTx("B", "C"),
      makeTx("C", "A"),
    ]);
    expect(graph.hasDirectedCycle()).toBe(true);
    expect(graph.hasDirectedCycleFrom("A")).toBe(true);
  });

  it("detects a cycle reachable from an entry node", () => {
    const graph = buildCounterpartyGraph([
      makeTx("S", "A"),
      makeTx("A", "B"),
      makeTx("B", "A"),
    ]);
    expect(graph.hasDirectedCycle()).toBe(true);
    expect(graph.hasDirectedCycleFrom("S")).toBe(true);
  });

  it("returns false for unknown start node in hasDirectedCycleFrom", () => {
    const graph = buildCounterpartyGraph([makeTx("A", "B")]);
    expect(graph.hasDirectedCycleFrom("MISSING")).toBe(false);
  });
});
