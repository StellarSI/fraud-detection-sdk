/**
 * Bounded, bidirectional graph with directed and undirected views (issue #46).
 *
 * This is the shared representation graph features build on: clustering
 * (#44), fund-flow tracing (#45) and degree features (#47) can all work from
 * one adjacency structure instead of inventing their own. The class is
 * synchronous and has no I/O, so every operation is pure and easy to test.
 *
 * Bounds are inclusive caps: when a cap is reached further nodes/edges are
 * dropped and `truncated` is set, so a very large history cannot grow memory
 * without limit. Callers are expected to report truncation, not hide it.
 */

import { ValidationError } from "../errors.js";
import type {
  GraphEdge,
  GraphNode,
  GraphOptions,
  GraphTraversalOptions,
  GraphView,
  GraphVisit,
} from "./types.js";

/** Default cap on distinct accounts retained in one graph. */
export const DEFAULT_GRAPH_MAX_NODES = 10_000;
/** Default cap on distinct edges retained in one graph. */
export const DEFAULT_GRAPH_MAX_EDGES = 50_000;

function resolveLimit(value: number | undefined, fallback: number, label: string): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isFinite(value) || value < 1) {
    throw new ValidationError(`${label} must be a positive finite number`);
  }
  return Math.trunc(value);
}

function requireAccount(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ValidationError(`${label} must be a non-empty string`);
  }
  return value.trim();
}

/**
 * In-memory graph of accounts and value-transfer edges.
 *
 * Nodes and edges are retained in insertion order for storage but every
 * query returns sorted output, so results are deterministic regardless of
 * the order records arrived in.
 */
export class Graph {
  private readonly nodesById = new Map<string, GraphNode>();
  private readonly edgesById = new Map<string, GraphEdge>();
  private readonly outAdjacency = new Map<string, Set<string>>();
  private readonly inAdjacency = new Map<string, Set<string>>();
  private readonly undirectedAdjacency = new Map<string, Set<string>>();
  private readonly maxNodes: number;
  private readonly maxEdges: number;
  private truncatedFlag = false;

  constructor(options: GraphOptions = {}) {
    this.maxNodes = resolveLimit(options.maxNodes, DEFAULT_GRAPH_MAX_NODES, "maxNodes");
    this.maxEdges = resolveLimit(options.maxEdges, DEFAULT_GRAPH_MAX_EDGES, "maxEdges");
  }

  /** Number of retained nodes. */
  get nodeCount(): number {
    return this.nodesById.size;
  }

  /** Number of retained edges. */
  get edgeCount(): number {
    return this.edgesById.size;
  }

  /** True when a node or edge was dropped because a bound was reached. */
  get truncated(): boolean {
    return this.truncatedFlag;
  }

  private ensureNode(id: string): boolean {
    if (this.nodesById.has(id)) {
      return true;
    }
    if (this.nodesById.size >= this.maxNodes) {
      this.truncatedFlag = true;
      return false;
    }
    this.nodesById.set(id, { id });
    this.outAdjacency.set(id, new Set());
    this.inAdjacency.set(id, new Set());
    this.undirectedAdjacency.set(id, new Set());
    return true;
  }

  /** Adds an account. Returns false when the node cap was reached. */
  addNode(node: GraphNode | string): boolean {
    const id = requireAccount(typeof node === "string" ? node : node?.id, "node.id");
    const created = this.ensureNode(id);
    if (created && typeof node !== "string" && node.metadata !== undefined) {
      const current = this.nodesById.get(id);
      if (current !== undefined) {
        this.nodesById.set(id, { ...current, metadata: { ...node.metadata } });
      }
    }
    return created;
  }

  /** Returns true when the account is present. */
  hasNode(id: string): boolean {
    return this.nodesById.has(id);
  }

  /** Returns the stored node, or undefined when absent. */
  getNode(id: string): GraphNode | undefined {
    return this.nodesById.get(id);
  }

  /** Sorted account ids currently retained. */
  nodeIds(): string[] {
    return Array.from(this.nodesById.keys()).sort();
  }

  /** Sorted nodes currently retained. */
  nodes(): GraphNode[] {
    return this.nodeIds().map((id) => this.nodesById.get(id) as GraphNode);
  }

  /**
   * Adds a directed edge, creating both endpoints when needed.
   *
   * Self-loops, empty ids and duplicate edge ids are ignored. A duplicate
   * edge id does not increase {@link edgeCount}.
   */
  addEdge(edge: GraphEdge): boolean {
    if (!edge || typeof edge !== "object") {
      throw new ValidationError("edge must be a GraphEdge object");
    }
    const id = requireAccount(edge.id, "edge.id");
    const from = requireAccount(edge.from, "edge.from");
    const to = requireAccount(edge.to, "edge.to");
    if (from === to) {
      return false;
    }
    if (this.edgesById.has(id)) {
      return true;
    }
    if (!this.ensureNode(from) || !this.ensureNode(to)) {
      return false;
    }
    if (this.edgesById.size >= this.maxEdges) {
      this.truncatedFlag = true;
      return false;
    }

    const normalized: GraphEdge = {
      id,
      from,
      to,
      ...(edge.asset !== undefined ? { asset: edge.asset } : {}),
      ...(edge.amount !== undefined ? { amount: edge.amount } : {}),
      ...(edge.ledger !== undefined ? { ledger: edge.ledger } : {}),
      ...(edge.occurredAt !== undefined ? { occurredAt: edge.occurredAt } : {}),
    };
    this.edgesById.set(id, normalized);
    (this.outAdjacency.get(from) as Set<string>).add(to);
    (this.inAdjacency.get(to) as Set<string>).add(from);
    (this.undirectedAdjacency.get(from) as Set<string>).add(to);
    (this.undirectedAdjacency.get(to) as Set<string>).add(from);
    return true;
  }

  /** Returns the stored edge, or undefined when absent. */
  getEdge(id: string): GraphEdge | undefined {
    return this.edgesById.get(id);
  }

  /** Sorted edges currently retained. */
  edges(): GraphEdge[] {
    return Array.from(this.edgesById.values()).sort((left, right) =>
      left.id.localeCompare(right.id)
    );
  }

  /** Sorted edges outgoing from `id`. */
  outEdges(id: string): GraphEdge[] {
    return this.edges().filter((edge) => edge.from === id);
  }

  /** Sorted edges incoming to `id`. */
  inEdges(id: string): GraphEdge[] {
    return this.edges().filter((edge) => edge.to === id);
  }

  /** Sorted neighbors in the requested view. */
  neighbors(id: string, view: GraphView = "undirected"): string[] {
    const adjacency =
      view === "directed-out"
        ? this.outAdjacency.get(id)
        : view === "directed-in"
          ? this.inAdjacency.get(id)
          : this.undirectedAdjacency.get(id);
    return adjacency ? Array.from(adjacency).sort() : [];
  }

  /** Sorted outgoing neighbors (accounts this account paid). */
  outNeighbors(id: string): string[] {
    return this.neighbors(id, "directed-out");
  }

  /** Sorted incoming neighbors (accounts that paid this account). */
  inNeighbors(id: string): string[] {
    return this.neighbors(id, "directed-in");
  }

  /** Number of neighbors in the requested view. */
  degree(id: string, view: GraphView = "undirected"): number {
    return this.neighbors(id, view).length;
  }

  /** Outgoing degree. */
  outDegree(id: string): number {
    return this.degree(id, "directed-out");
  }

  /** Incoming degree. */
  inDegree(id: string): number {
    return this.degree(id, "directed-in");
  }

  /**
   * Breadth-first traversal from `id`, returning the visit order and depth.
   *
   * The start node is included at depth 0. A depth or node cap stops the
   * traversal deterministically, and `truncated` reflects the graph's own
   * bounds (the traversal caps are reported through the returned length).
   */
  traverse(id: string, options: GraphTraversalOptions = {}): GraphVisit[] {
    if (!this.hasNode(id)) {
      return [];
    }
    const view = options.view ?? "directed-out";
    const maxDepth = options.maxDepth === undefined ? Number.POSITIVE_INFINITY : options.maxDepth;
    if (
      maxDepth !== Number.POSITIVE_INFINITY &&
      (!Number.isInteger(maxDepth) || maxDepth < 0)
    ) {
      throw new ValidationError("maxDepth must be a non-negative integer");
    }
    const maxNodes = options.maxNodes === undefined ? Number.POSITIVE_INFINITY : options.maxNodes;
    if (
      maxNodes !== Number.POSITIVE_INFINITY &&
      (!Number.isInteger(maxNodes) || maxNodes < 0)
    ) {
      throw new ValidationError("maxNodes must be a non-negative integer");
    }
    if (maxNodes === 0) {
      return [];
    }

    const visited = new Set<string>([id]);
    const queue: GraphVisit[] = [{ id, depth: 0 }];
    for (let index = 0; index < queue.length; index += 1) {
      const current = queue[index];
      if (current.depth >= maxDepth) {
        continue;
      }
      for (const next of this.neighbors(current.id, view)) {
        if (visited.has(next)) {
          continue;
        }
        visited.add(next);
        queue.push({ id: next, depth: current.depth + 1 });
        if (queue.length >= maxNodes) {
          return queue;
        }
      }
    }
    return queue;
  }

  /** Sorted ids reachable from `id` in the requested view, excluding the start. */
  reachableFrom(id: string, options: GraphTraversalOptions = {}): string[] {
    return this.traverse(id, options)
      .map((visit) => visit.id)
      .filter((nodeId) => nodeId !== id)
      .sort();
  }
}

export default Graph;
