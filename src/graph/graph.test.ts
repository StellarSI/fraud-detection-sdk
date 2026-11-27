/** Unit tests for the shared graph data structures (issue #46). */

import { describe, expect, it } from "vitest";
import { Graph } from "./graph.js";
import { ValidationError } from "../errors.js";

function edge(id: string, from: string, to: string, overrides = {}) {
  return { id, from, to, ...overrides };
}

describe("Graph (issue #46)", () => {
  it("stores nodes and edges with deduplication", () => {
    const graph = new Graph();
    expect(graph.addNode({ id: "A", metadata: { role: "anchor" } })).toBe(true);
    expect(graph.addEdge(edge("e1", "A", "B"))).toBe(true);
    expect(graph.addEdge(edge("e1", "A", "B"))).toBe(true);
    expect(graph.addEdge(edge("loop", "A", "A"))).toBe(false);

    expect(graph.nodeCount).toBe(2);
    expect(graph.edgeCount).toBe(1);
    expect(graph.getNode("A")?.metadata).toEqual({ role: "anchor" });
    expect(graph.getEdge("e1")).toMatchObject({ from: "A", to: "B" });
    expect(graph.truncated).toBe(false);
  });

  it("answers degree and neighbor queries in both views", () => {
    const graph = new Graph();
    graph.addEdge(edge("e1", "A", "B"));
    graph.addEdge(edge("e2", "C", "B"));
    graph.addEdge(edge("e3", "B", "D"));

    expect(graph.outNeighbors("B")).toEqual(["D"]);
    expect(graph.inNeighbors("B")).toEqual(["A", "C"]);
    expect(graph.neighbors("B")).toEqual(["A", "C", "D"]);
    expect(graph.outDegree("B")).toBe(1);
    expect(graph.inDegree("B")).toBe(2);
    expect(graph.degree("B")).toBe(3);
    expect(graph.nodeIds()).toEqual(["A", "B", "C", "D"]);
  });

  it("traverses directed and undirected views with depth and node caps", () => {
    const graph = new Graph();
    graph.addEdge(edge("e1", "A", "B"));
    graph.addEdge(edge("e2", "B", "C"));
    graph.addEdge(edge("e3", "C", "D"));

    expect(graph.traverse("A")).toEqual([
      { id: "A", depth: 0 },
      { id: "B", depth: 1 },
      { id: "C", depth: 2 },
      { id: "D", depth: 3 },
    ]);
    expect(graph.traverse("A", { maxDepth: 1 })).toEqual([
      { id: "A", depth: 0 },
      { id: "B", depth: 1 },
    ]);
    expect(graph.traverse("D")).toEqual([{ id: "D", depth: 0 }]);
    expect(graph.reachableFrom("D", { view: "undirected" })).toEqual(["A", "B", "C"]);
    expect(graph.traverse("A", { maxNodes: 2 })).toHaveLength(2);
  });

  it("keeps traversal deterministic on branching and cyclic graphs", () => {
    const graph = new Graph();
    graph.addEdge(edge("e1", "A", "B"));
    graph.addEdge(edge("e2", "A", "C"));
    graph.addEdge(edge("e3", "B", "D"));
    graph.addEdge(edge("e4", "C", "D"));
    graph.addEdge(edge("e5", "D", "A"));

    const first = graph.traverse("A", { view: "undirected" });
    const second = graph.traverse("A", { view: "undirected" });
    expect(first).toEqual(second);
    expect(first).toHaveLength(4);
    expect(graph.reachableFrom("A")).toEqual(["B", "C", "D"]);
  });

  it("reports truncation when bounds are reached", () => {
    const graph = new Graph({ maxNodes: 2, maxEdges: 1 });
    expect(graph.addEdge(edge("e1", "A", "B"))).toBe(true);
    expect(graph.addEdge(edge("e2", "B", "C"))).toBe(false);
    expect(graph.truncated).toBe(true);
    expect(graph.nodeCount).toBe(2);
    expect(graph.edgeCount).toBe(1);
  });

  it("validates malformed input", () => {
    const graph = new Graph();
    expect(() => graph.addNode(" ")).toThrow(ValidationError);
    expect(() => graph.addEdge(edge("e1", "", "B"))).toThrow(ValidationError);
    expect(() => new Graph({ maxNodes: 0 })).toThrow(ValidationError);
    expect(() => graph.traverse("A", { maxDepth: -1 })).toThrow(ValidationError);
    expect(() => graph.traverse("A", { maxNodes: 1.5 })).toThrow(ValidationError);
    expect(graph.traverse("MISSING")).toEqual([]);
  });
});
