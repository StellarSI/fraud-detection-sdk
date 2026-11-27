/** Unit tests for fund-flow tracing (issue #45). */

import { describe, expect, it } from "vitest";
import type { Transaction } from "../clients/horizon.js";
import {
  buildFundFlowGraph,
  traceFundFlow,
  traceFundFlowFromTransactions,
} from "./fundFlow.js";

function payment(id: string, from: string, to: string, amount: number, assetCode = "USDC"): Transaction {
  return {
    id,
    createdAt: "2026-01-01T00:00:00Z",
    sourceAccount: from,
    type: "payment",
    amount,
    assetCode,
    from,
    to,
    pagingToken: id,
    ledger: 1000,
  };
}

describe("fund-flow tracing (issue #45)", () => {
  it("traces a linear chain to the configured depth", () => {
    const txs = [
      payment("t1", "A", "B", 100),
      payment("t2", "B", "C", 80),
      payment("t3", "C", "D", 60),
    ];

    const trace = traceFundFlowFromTransactions(txs, "A", { maxDepth: 2 });
    expect(trace.paths).toHaveLength(1);
    expect(trace.paths[0].hops.map((hop) => hop.account)).toEqual(["B", "C"]);
    expect(trace.paths[0].hops[1].cumulativeAmount).toBe(180);
    expect(trace.paths[0].totalAmount).toBe(180);
    expect(trace.counterparties).toEqual(["B", "C"]);
    expect(trace.truncated).toBe(false);

    const full = traceFundFlowFromTransactions(txs, "A");
    expect(full.paths[0].hops.map((hop) => hop.account)).toEqual(["B", "C", "D"]);
  });

  it("returns one path per branch", () => {
    const txs = [
      payment("t1", "A", "B", 100),
      payment("t2", "A", "C", 50),
      payment("t3", "B", "D", 40),
      payment("t4", "C", "E", 30),
    ];
    const trace = traceFundFlowFromTransactions(txs, "A");

    expect(trace.paths.map((path) => [path.terminal, path.totalAmount])).toEqual([
      ["D", 140],
      ["E", 80],
    ]);
    expect(trace.counterparties).toEqual(["B", "C", "D", "E"]);
  });

  it("stops at cycles without revisiting an account", () => {
    const txs = [
      payment("t1", "A", "B", 100),
      payment("t2", "B", "C", 80),
      payment("t3", "C", "A", 60),
    ];
    const trace = traceFundFlowFromTransactions(txs, "A");

    expect(trace.paths).toHaveLength(1);
    expect(trace.paths[0].hops.map((hop) => hop.account)).toEqual(["B", "C"]);
    expect(trace.counterparties).toEqual(["B", "C"]);
  });

  it("applies amount filters and asset labels", () => {
    const txs = [
      payment("t1", "A", "B", 100),
      payment("t2", "B", "C", 1),
      payment("t3", "A", "D", 500, "XLM"),
    ];
    const filtered = traceFundFlowFromTransactions(txs, "A", { minAmount: 10 });
    expect(filtered.paths.map((path) => path.terminal)).toEqual(["B", "D"]);
    expect(filtered.paths.map((path) => path.asset)).toEqual(["USDC", "XLM"]);

    const mixed = traceFundFlowFromTransactions(txs, "A", {
      minAmount: 0,
      maxDepth: 1,
    });
    expect(mixed.paths).toHaveLength(2);
  });

  it("traces incoming flows towards the seed", () => {
    const txs = [
      payment("t1", "A", "B", 100),
      payment("t2", "B", "C", 80),
    ];
    const trace = traceFundFlowFromTransactions(txs, "C", {
      direction: "incoming",
    });
    expect(trace.direction).toBe("incoming");
    expect(trace.paths[0].hops.map((hop) => hop.account)).toEqual(["B", "A"]);
  });

  it("bounds paths and reports truncation", () => {
    const txs = [
      payment("t1", "A", "B", 100),
      payment("t2", "A", "C", 90),
      payment("t3", "A", "D", 80),
    ];
    const graph = buildFundFlowGraph(txs, { maxNodes: 2 });
    expect(graph.truncated).toBe(true);

    const trace = traceFundFlow(graph, "A", { maxPaths: 2 });
    expect(trace.paths.length).toBeLessThanOrEqual(2);
    expect(trace.truncated).toBe(true);
  });

  it("is deterministic across insertion orders", () => {
    const forward = [
      payment("t1", "A", "B", 100),
      payment("t2", "A", "C", 50),
    ];
    const reverse = [...forward].reverse();
    expect(traceFundFlowFromTransactions(forward, "A")).toEqual(
      traceFundFlowFromTransactions(reverse, "A")
    );
  });

  it("returns an empty trace for an unknown seed and validates options", () => {
    const graph = buildFundFlowGraph([payment("t1", "A", "B", 100)]);
    expect(traceFundFlow(graph, "MISSING").paths).toEqual([]);
    expect(() => traceFundFlow(graph, "A", { maxDepth: -1 })).toThrow();
    expect(() => traceFundFlow(graph, "A", { minAmount: -1 })).toThrow();
    expect(() => traceFundFlow(graph, "A", { direction: "sideways" as "outgoing" })).toThrow();
  });
});
