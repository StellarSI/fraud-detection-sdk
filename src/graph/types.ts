/**
 * Shared graph data structures (issue #46).
 *
 * Graph features (counterparty graph #20, clustering #44, fund-flow tracing
 * #45, degree features #47) all need the same small vocabulary: nodes that
 * describe accounts, edges that describe value transfer, and directed and
 * undirected views over them. These types are deliberately plain data so a
 * graph can be built and inspected without any infrastructure.
 */

/** Which adjacency view a query or traversal uses. */
export type GraphView = "directed-out" | "directed-in" | "undirected";

/** Scalar metadata carried on a graph node. */
export type GraphMetadataValue = string | number | boolean | null;

/** An account in the graph. */
export interface GraphNode {
  /** Stable account identifier. */
  readonly id: string;
  /** Optional, sanitized metadata (no secrets or personal data). */
  readonly metadata?: Readonly<Record<string, GraphMetadataValue>>;
}

/** A value transfer between two accounts. */
export interface GraphEdge {
  /** Stable edge id, used for deduplication. */
  readonly id: string;
  /** Sending account. */
  readonly from: string;
  /** Receiving account. */
  readonly to: string;
  /** Canonical asset identifier (for example `XLM` or `USDC:G...`). */
  readonly asset?: string;
  /** Transferred amount in asset units. */
  readonly amount?: number;
  /** Ledger the transfer was closed in. */
  readonly ledger?: number;
  /** UTC ISO-8601 close time of the transfer. */
  readonly occurredAt?: string;
}

/** Bounds for {@link Graph}. */
export interface GraphOptions {
  /** Maximum distinct nodes retained. Default: 10,000. */
  readonly maxNodes?: number;
  /** Maximum distinct edges retained. Default: 50,000. */
  readonly maxEdges?: number;
}

/** Options for graph traversal helpers. */
export interface GraphTraversalOptions {
  /** Adjacency view to follow. Default: `directed-out`. */
  readonly view?: GraphView;
  /** Maximum depth to explore from the start node. Default: unbounded. */
  readonly maxDepth?: number;
  /** Maximum distinct nodes to visit. Default: unbounded. */
  readonly maxNodes?: number;
}

/** One visited node in a traversal. */
export interface GraphVisit {
  /** Account id. */
  readonly id: string;
  /** Hops from the start node (the start has depth 0). */
  readonly depth: number;
}
