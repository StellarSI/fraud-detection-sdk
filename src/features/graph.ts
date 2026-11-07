/**
 * Graph feature extraction (issue #20).
 *
 * Many Stellar abuse patterns are relational: layering through hops,
 * fan-out rings, and shared counterparties. This module builds a
 * bounded, in-memory counterparty graph from normalized transactions
 * (#13) and exposes per-account degree, clustering, and reachability
 * features.
 *
 * The internal representation is intentionally small; when the shared
 * graph structures land (#46) this module can adopt them without
 * changing its public feature surface.
 *
 * Bounding: both node and edge counts are capped (defaults below) so a
 * very large history cannot grow memory without limit. When a cap is
 * hit, further nodes/edges are dropped and `truncated` is set.
 */

import type { Transaction } from "../clients/horizon.js";
import { ValidationError } from "../errors.js";
import type {
  FeatureContext,
  FeatureMap,
  FeatureProvider,
} from "./types.js";

/** Default cap on distinct accounts retained in one graph. */
export const DEFAULT_MAX_GRAPH_NODES = 10_000;
/** Default cap on distinct directed edges retained in one graph. */
export const DEFAULT_MAX_GRAPH_EDGES = 50_000;
/**
 * Above this undirected degree, local clustering is reported as 0
 * instead of doing quadratic work on a hub.
 */
export const DEFAULT_MAX_CLUSTERING_DEGREE = 256;

/** Bounds for {@link CounterpartyGraph}. */
export interface CounterpartyGraphOptions {
  /** Maximum distinct accounts retained. Default: 10,000. */
  readonly maxNodes?: number;
  /** Maximum distinct directed edges retained. Default: 50,000. */
  readonly maxEdges?: number;
}

function resolveLimit(
  value: number | undefined,
  fallback: number,
  label: string
): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isFinite(value) || value < 1) {
    throw new ValidationError(`${label} must be a positive finite number`);
  }
  return Math.trunc(value);
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/**
 * Bounded directed counterparty graph with an undirected projection.
 *
 * Nodes are account IDs; edges represent an observed value transfer from
 * one account to another. Degrees and neighbors are available in both
 * views, and traversal helpers make layering paths easy to inspect.
 */
export class CounterpartyGraph {
  private readonly outAdjacency = new Map<string, Set<string>>();
  private readonly inAdjacency = new Map<string, Set<string>>();
  private readonly undirectedAdjacency = new Map<string, Set<string>>();
  private readonly maxNodes: number;
  private readonly maxEdges: number;
  private edgeTotal = 0;
  private truncatedFlag = false;

  constructor(options: CounterpartyGraphOptions = {}) {
    this.maxNodes = resolveLimit(options.maxNodes, DEFAULT_MAX_GRAPH_NODES, "maxNodes");
    this.maxEdges = resolveLimit(options.maxEdges, DEFAULT_MAX_GRAPH_EDGES, "maxEdges");
  }

  /** Number of distinct accounts currently retained. */
  get nodeCount(): number {
    return this.outAdjacency.size;
  }

  /** Number of distinct directed edges currently retained. */
  get edgeCount(): number {
    return this.edgeTotal;
  }

  /** True when a node or edge was dropped because a bound was reached. */
  get truncated(): boolean {
    return this.truncatedFlag;
  }

  /** Returns true when the account is present in the graph. */
  hasNode(accountId: string): boolean {
    return this.outAdjacency.has(accountId);
  }

  private ensureNode(accountId: string): boolean {
    if (this.outAdjacency.has(accountId)) {
      return true;
    }
    if (this.outAdjacency.size >= this.maxNodes) {
      return false;
    }
    this.outAdjacency.set(accountId, new Set());
    this.inAdjacency.set(accountId, new Set());
    this.undirectedAdjacency.set(accountId, new Set());
    return true;
  }

  /**
   * Adds a directed edge. Self-loops, empty IDs, and duplicates are
   * ignored; a duplicate does not increase {@link edgeCount}.
   *
   * @returns True when the edge is present after the call.
   */
  addEdge(from: string, to: string): boolean {
    if (
      typeof from !== "string" ||
      typeof to !== "string" ||
      from.length === 0 ||
      to.length === 0 ||
      from === to
    ) {
      return false;
    }

    const fromReady = this.ensureNode(from);
    const toReady = this.ensureNode(to);
    if (!fromReady || !toReady) {
      this.truncatedFlag = true;
      return false;
    }

    const outgoing = this.outAdjacency.get(from);
    const incoming = this.inAdjacency.get(to);
    const fromNeighbors = this.undirectedAdjacency.get(from);
    const toNeighbors = this.undirectedAdjacency.get(to);
    if (!outgoing || !incoming || !fromNeighbors || !toNeighbors) {
      return false;
    }

    if (outgoing.has(to)) {
      return true;
    }
    if (this.edgeTotal >= this.maxEdges) {
      this.truncatedFlag = true;
      return false;
    }

    outgoing.add(to);
    incoming.add(from);
    fromNeighbors.add(to);
    toNeighbors.add(from);
    this.edgeTotal += 1;
    return true;
  }

  /** Sorted outgoing neighbors (accounts this account paid). */
  outNeighbors(accountId: string): string[] {
    return this.sortedSet(this.outAdjacency.get(accountId));
  }

  /** Sorted incoming neighbors (accounts that paid this account). */
  inNeighbors(accountId: string): string[] {
    return this.sortedSet(this.inAdjacency.get(accountId));
  }

  /** Sorted distinct counterparties in the undirected view. */
  neighbors(accountId: string): string[] {
    return this.sortedSet(this.undirectedAdjacency.get(accountId));
  }

  /** Number of outgoing edges. */
  outDegree(accountId: string): number {
    return this.outAdjacency.get(accountId)?.size ?? 0;
  }

  /** Number of incoming edges. */
  inDegree(accountId: string): number {
    return this.inAdjacency.get(accountId)?.size ?? 0;
  }

  /** Number of distinct counterparties (undirected degree). */
  degree(accountId: string): number {
    return this.undirectedAdjacency.get(accountId)?.size ?? 0;
  }

  /**
   * Accounts reachable from `accountId` by following outgoing edges.
   *
   * @param accountId - Starting account.
   * @param maxNodes - Maximum reached accounts to return (breadth-first).
   * @returns Sorted reachable account IDs, excluding the start.
   */
  reachableFrom(
    accountId: string,
    maxNodes: number = Number.POSITIVE_INFINITY
  ): string[] {
    if (!this.hasNode(accountId)) {
      return [];
    }
    const limit = Number.isFinite(maxNodes)
      ? Math.max(0, Math.trunc(maxNodes))
      : Number.POSITIVE_INFINITY;
    if (limit === 0) {
      return [];
    }

    const visited = new Set<string>([accountId]);
    const queue: string[] = [accountId];

    for (let index = 0; index < queue.length; index += 1) {
      if (visited.size - 1 >= limit) {
        break;
      }
      const outgoing = this.outAdjacency.get(queue[index]);
      if (!outgoing) {
        continue;
      }
      for (const next of Array.from(outgoing).sort()) {
        if (!visited.has(next)) {
          visited.add(next);
          queue.push(next);
          if (visited.size - 1 >= limit) {
            break;
          }
        }
      }
    }

    return Array.from(visited)
      .filter((node) => node !== accountId)
      .sort();
  }

  /**
   * Local clustering coefficient in the undirected projection.
   *
   * `2 * linksBetweenNeighbors / (k * (k - 1))`, where `k` is the
   * undirected degree. Returns 0 for fewer than two neighbors and for
   * hubs above `maxDegree` (a deliberate, documented bound).
   */
  clusteringCoefficient(
    accountId: string,
    maxDegree: number = DEFAULT_MAX_CLUSTERING_DEGREE
  ): number {
    const neighbors = this.undirectedAdjacency.get(accountId);
    if (!neighbors || neighbors.size < 2) {
      return 0;
    }
    const limit = Number.isFinite(maxDegree)
      ? Math.max(0, Math.trunc(maxDegree))
      : Number.POSITIVE_INFINITY;
    if (neighbors.size > limit) {
      return 0;
    }

    const list = Array.from(neighbors).sort();
    let links = 0;
    for (let index = 0; index < list.length; index += 1) {
      const adjacency = this.undirectedAdjacency.get(list[index]);
      if (!adjacency) {
        continue;
      }
      for (let other = index + 1; other < list.length; other += 1) {
        if (adjacency.has(list[other])) {
          links += 1;
        }
      }
    }

    return round4((2 * links) / (list.length * (list.length - 1)));
  }

  /**
   * Returns true when the directed graph contains any cycle.
   *
   * Uses DFS with a recursion stack (path set) so back-edges that close a
   * cycle are detected. This supports layering/ring detectors (e.g. path
   * payment layering, #26; graph structures, #46) without requiring a
   * separate graph implementation.
   */
  hasDirectedCycle(): boolean {
    const visited = new Set<string>();
    const inStack = new Set<string>();

    const visit = (node: string): boolean => {
      if (inStack.has(node)) {
        return true;
      }
      if (visited.has(node)) {
        return false;
      }
      visited.add(node);
      inStack.add(node);
      const outgoing = this.outAdjacency.get(node);
      if (outgoing) {
        for (const next of Array.from(outgoing).sort()) {
          if (visit(next)) {
            return true;
          }
        }
      }
      inStack.delete(node);
      return false;
    };

    for (const node of Array.from(this.outAdjacency.keys()).sort()) {
      if (visit(node)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Returns true when `accountId` can reach a directed cycle by
   * following outgoing edges (or is on a cycle reachable from itself).
   *
   * Useful for flagging accounts involved in circular layering flows.
   */
  hasDirectedCycleFrom(accountId: string): boolean {
    if (!this.hasNode(accountId)) {
      return false;
    }
    const reachable = new Set<string>([accountId, ...this.reachableFrom(accountId)]);
    const visited = new Set<string>();
    const inStack = new Set<string>();

    const visit = (node: string): boolean => {
      if (!reachable.has(node)) {
        return false;
      }
      if (inStack.has(node)) {
        return true;
      }
      if (visited.has(node)) {
        return false;
      }
      visited.add(node);
      inStack.add(node);
      const outgoing = this.outAdjacency.get(node);
      if (outgoing) {
        for (const next of Array.from(outgoing).sort()) {
          if (visit(next)) {
            return true;
          }
        }
      }
      inStack.delete(node);
      return false;
    };

    return visit(accountId);
  }

  private sortedSet(values: Set<string> | undefined): string[] {
    return values ? Array.from(values).sort() : [];
  }
}

/**
 * Builds a bounded graph from transaction counterparties.
 *
 * @param transactions - Normalized transactions (issue #13).
 * @param options - Node/edge caps.
 * @returns A populated {@link CounterpartyGraph}.
 * @throws {ValidationError} If `transactions` is not an array or a bound
 *   is not a positive finite number.
 */
export function buildCounterpartyGraph(
  transactions: readonly Transaction[],
  options: CounterpartyGraphOptions = {}
): CounterpartyGraph {
  if (!Array.isArray(transactions)) {
    throw new ValidationError("transactions must be an array");
  }

  const graph = new CounterpartyGraph(options);
  for (const transaction of transactions) {
    if (!transaction || typeof transaction !== "object") {
      continue;
    }
    const from = transaction.from ?? transaction.sourceAccount;
    const to = transaction.to;
    if (
      typeof from === "string" &&
      from.length > 0 &&
      typeof to === "string" &&
      to.length > 0
    ) {
      graph.addEdge(from, to);
    }
  }
  return graph;
}

/** Options for {@link extractGraphFeatures}. */
export interface GraphFeatureOptions {
  /** Maximum distinct accounts retained. Default: 10,000. */
  readonly maxNodes?: number;
  /** Maximum distinct directed edges retained. Default: 50,000. */
  readonly maxEdges?: number;
  /** Hub cutoff for clustering; above it the coefficient is 0. */
  readonly maxClusteringDegree?: number;
  /** Maximum reachable accounts to enumerate. Default: graph size. */
  readonly maxReachableNodes?: number;
}

/** Per-account graph features. */
export interface GraphFeatures {
  /** Accounts this account paid directly. */
  readonly outDegree: number;
  /** Accounts that paid this account directly. */
  readonly inDegree: number;
  /** Sum of outgoing and incoming degree. */
  readonly totalDegree: number;
  /** Distinct counterparties in the undirected view. */
  readonly uniqueCounterparties: number;
  /** Local clustering coefficient in [0, 1]. */
  readonly clusteringCoefficient: number;
  /** Accounts reachable by following outgoing edges. */
  readonly reachableAccounts: number;
  /** Total nodes retained in the graph. */
  readonly nodeCount: number;
  /** Total directed edges retained in the graph. */
  readonly edgeCount: number;
  /** Whether any node or edge was dropped due to a bound. */
  readonly truncated: boolean;
}

/**
 * Extracts per-account graph features.
 *
 * Missing accounts yield zeroed account features while still reporting
 * the graph's size, so callers can distinguish "no activity" from
 * "history unavailable".
 *
 * @param graph - Graph built by {@link buildCounterpartyGraph}.
 * @param accountId - Account to describe.
 * @param options - Bounds for clustering/reachability.
 */
export function extractGraphFeatures(
  graph: CounterpartyGraph,
  accountId: string,
  options: GraphFeatureOptions = {}
): GraphFeatures {
  const present = graph.hasNode(accountId);
  const outDegree = present ? graph.outDegree(accountId) : 0;
  const inDegree = present ? graph.inDegree(accountId) : 0;
  const maxReachable = options.maxReachableNodes ?? graph.nodeCount;

  return {
    outDegree,
    inDegree,
    totalDegree: outDegree + inDegree,
    uniqueCounterparties: present ? graph.degree(accountId) : 0,
    clusteringCoefficient: present
      ? graph.clusteringCoefficient(accountId, options.maxClusteringDegree)
      : 0,
    reachableAccounts: present
      ? graph.reachableFrom(accountId, maxReachable).length
      : 0,
    nodeCount: graph.nodeCount,
    edgeCount: graph.edgeCount,
    truncated: graph.truncated,
  };
}

/**
 * Flattens graph features into the registry's uniform map (#24).
 *
 * @param features - Output of {@link extractGraphFeatures}.
 */
export function graphFeaturesToFeatureMap(features: GraphFeatures): FeatureMap {
  return {
    graphOutDegree: features.outDegree,
    graphInDegree: features.inDegree,
    graphTotalDegree: features.totalDegree,
    graphUniqueCounterparties: features.uniqueCounterparties,
    graphClusteringCoefficient: features.clusteringCoefficient,
    graphReachableAccounts: features.reachableAccounts,
    graphNodeCount: features.nodeCount,
    graphEdgeCount: features.edgeCount,
    graphTruncated: features.truncated,
  };
}

/**
 * Creates a registry-ready graph provider (#20, #24).
 *
 * @param options - Graph bounds; the scored account comes from context.
 */
export function createGraphFeatureProvider(
  options: GraphFeatureOptions = {}
): FeatureProvider {
  return {
    name: "graph",
    compute(context: FeatureContext): FeatureMap {
      if (
        typeof context.accountId !== "string" ||
        context.accountId.length === 0
      ) {
        throw new ValidationError("Graph features require an accountId");
      }
      const graph = buildCounterpartyGraph(context.transactions, options);
      return graphFeaturesToFeatureMap(
        extractGraphFeatures(graph, context.accountId, options)
      );
    },
  };
}
