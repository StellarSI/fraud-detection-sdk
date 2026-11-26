/**
 * Tests for counterparty clustering (issue #44).
 *
 * Cover the three topologies named in the acceptance criteria —
 * disconnected, star, and dense — plus pluggable algorithms and the
 * feature-provider contract.
 */

import { describe, expect, it } from "vitest";
import {
  buildCounterpartyGraph,
  type CounterpartyGraph,
} from "../features/graph.js";
import type { Transaction } from "../clients/horizon.js";
import {
  ConnectedComponentsClustering,
  LabelPropagationClustering,
  computeClusters,
  createClusteringFeatureProvider,
  extractClusteringFeatures,
} from "./clustering.js";

function tx(from: string, to: string, id: string): Transaction {
  return {
    id,
    createdAt: "2026-01-01T00:00:00Z",
    sourceAccount: from,
    type: "payment",
    amount: 1,
    from,
    to,
    pagingToken: id,
  };
}

function graphOf(edges: ReadonlyArray<readonly [string, string]>): CounterpartyGraph {
  return buildCounterpartyGraph(
    edges.map(([from, to], index) => tx(from, to, `tx-${index}`))
  );
}

describe("counterparty clustering", () => {
  it("computes separate clusters for disconnected components", () => {
    const graph = graphOf([
      ["A", "B"],
      ["B", "C"],
      ["X", "Y"],
    ]);
    const clusters = computeClusters(graph);

    expect(clusters).toHaveLength(2);
    expect(clusters[0].members).toEqual(["A", "B", "C"]);
    expect(clusters[0].size).toBe(3);
    expect(clusters[0].internalEdges).toBe(2);
    expect(clusters[1].members).toEqual(["X", "Y"]);
    expect(clusters[1].size).toBe(2);
  });

  it("exposes membership and size for the scored account", () => {
    const graph = graphOf([
      ["A", "B"],
      ["B", "C"],
    ]);
    const features = extractClusteringFeatures(graph, "A");

    expect(features.clusterId).toBe("cluster:A|B|C");
    expect(features.clusterSize).toBe(3);
    expect(features.clusterAlgorithm).toBe("connected-components");
    expect(features.clusterCount).toBe(1);
    expect(features.clusterTruncated).toBe(false);

    const missing = extractClusteringFeatures(graph, "MISSING");
    expect(missing.clusterId).toBe("");
    expect(missing.clusterSize).toBe(0);
    expect(missing.clusterIsTight).toBe(false);
  });

  it("does not treat a sparse star as a tight cluster", () => {
    const graph = graphOf([
      ["HUB", "L1"],
      ["HUB", "L2"],
      ["HUB", "L3"],
      ["HUB", "L4"],
    ]);
    const features = extractClusteringFeatures(graph, "HUB");

    expect(features.clusterSize).toBe(5);
    expect(features.clusterDensity).toBe(0.4);
    expect(features.clusterIsTight).toBe(false);
  });

  it("treats a dense component as a tight cluster", () => {
    const graph = graphOf([
      ["A", "B"],
      ["A", "C"],
      ["B", "C"],
      ["D", "E"],
    ]);
    const features = extractClusteringFeatures(graph, "A");

    expect(features.clusterSize).toBe(3);
    expect(features.clusterDensity).toBe(1);
    expect(features.clusterIsTight).toBe(true);
  });

  it("supports a pluggable label-propagation strategy", () => {
    const graph = graphOf([
      ["A", "B"],
      ["B", "C"],
      ["C", "A"],
      ["X", "Y"],
    ]);
    const algorithm = new LabelPropagationClustering();
    const clusters = computeClusters(graph, { algorithm });

    expect(algorithm.name).toBe("label-propagation");
    expect(clusters).toHaveLength(2);
    expect(clusters[0].members).toEqual(["A", "B", "C"]);
    expect(
      extractClusteringFeatures(graph, "A", { algorithm }).clusterAlgorithm
    ).toBe("label-propagation");
  });

  it("is deterministic across insertion orders", () => {
    const forward = graphOf([
      ["A", "B"],
      ["B", "C"],
      ["C", "A"],
    ]);
    const reverse = graphOf([
      ["C", "A"],
      ["B", "C"],
      ["A", "B"],
    ]);

    expect(computeClusters(forward)).toEqual(computeClusters(reverse));
  });

  it("exposes the connected-components strategy as an injectable algorithm", () => {
    const graph = graphOf([
      ["A", "B"],
      ["C", "D"],
    ]);
    const algorithm = new ConnectedComponentsClustering();
    expect(computeClusters(graph, { algorithm })).toHaveLength(2);
  });

  it("provides clustering features through the registry contract", () => {
    const provider = createClusteringFeatureProvider();
    const map = provider.compute({
      accountId: "A",
      transactions: [
        tx("A", "B", "one"),
        tx("B", "C", "two"),
        tx("C", "A", "three"),
      ],
    });

    expect(provider.name).toBe("counterparty-clustering");
    expect(map["clusterSize"]).toBe(3);
    expect(map["clusterIsTight"]).toBe(true);
  });

  it("returns zeroed features for a missing account without throwing", () => {
    const provider = createClusteringFeatureProvider();
    const map = provider.compute({ transactions: [tx("A", "B", "one")] });

    expect(map["clusterSize"]).toBe(0);
    expect(map["clusterIsTight"]).toBe(false);
  });

  it("validates options and graph input", () => {
    const graph = graphOf([["A", "B"]]);
    expect(() =>
      computeClusters(graph, { minClusterSize: 0 })
    ).toThrow(/minClusterSize/);
    expect(() =>
      computeClusters(graph, { minClusterDensity: 1.5 })
    ).toThrow(/minClusterDensity/);
    expect(() =>
      computeClusters(undefined as unknown as CounterpartyGraph)
    ).toThrow(/CounterpartyGraph/);
  });
});
