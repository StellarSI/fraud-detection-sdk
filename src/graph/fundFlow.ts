/**
 * Fund-flow tracing (issue #45).
 *
 * Follows value through chains of accounts from a seed, configured by depth
 * and minimum amount. Tracing is the explanation layer for layering and
 * obscured asset origin (README.md): it returns concrete paths and
 * counterparties rather than a single score.
 *
 * The implementation builds its own bounded adjacency from normalized
 * transactions (issue #13). It uses the same bounding discipline as the
 * counterparty graph (#20) and can be switched to the shared `Graph` (#46)
 * once that representation lands, without changing the result shape.
 *
 * Contract:
 * - Deterministic: nodes and edges are sorted before traversal.
 * - Bounded: depth, path count and visited-node count are capped; a capped
 *   traversal reports `truncated` instead of silently dropping results.
 * - Cycle-safe: an account is never revisited on the same path.
 */

import type { Transaction } from "../clients/horizon.js";
import { ValidationError } from "../errors.js";

/** Default maximum number of hops followed from the seed. */
export const DEFAULT_MAX_TRACE_DEPTH = 4;
/** Default maximum number of returned paths. */
export const DEFAULT_MAX_TRACE_PATHS = 100;
/** Default maximum number of distinct accounts visited in one trace. */
export const DEFAULT_MAX_TRACE_NODES = 1_000;

/** A directed value-transfer edge used by fund-flow tracing. */
export interface FundFlowEdge {
  /** Stable transaction/operation id. */
  readonly id: string;
  /** Sending account. */
  readonly from: string;
  /** Receiving account. */
  readonly to: string;
  /** Transferred amount in asset units. */
  readonly amount: number;
  /** Canonical asset id. */
  readonly asset: string;
  /** Ledger the transfer closed in, when known. */
  readonly ledger?: number;
  /** UTC ISO-8601 close time, when known. */
  readonly occurredAt?: string;
}

/** One step along a traced path. */
export interface FundFlowHop {
  /** Account reached at this step. */
  readonly account: string;
  /** Hops from the seed (1-based). */
  readonly depth: number;
  /** Edge that reached the account. */
  readonly edge: FundFlowEdge;
  /** Sum of amounts along the path so far, in the path's asset. */
  readonly cumulativeAmount: number;
}

/** One complete seed-to-terminal path. */
export interface FundFlowPath {
  /** Account the trace started from. */
  readonly seed: string;
  /** Ordered steps away from the seed. */
  readonly hops: readonly FundFlowHop[];
  /** Last account reached, or the seed when no edge qualified. */
  readonly terminal: string;
  /** Asset carried by the path; `mixed` when hops use several assets. */
  readonly asset: string;
  /** Sum of hop amounts (only meaningful for a single-asset path). */
  readonly totalAmount: number;
}

/** Result of a fund-flow trace. */
export interface FundFlowTrace {
  seed: string;
  direction: FundFlowDirection;
  maxDepth: number;
  minAmount: number;
  paths: readonly FundFlowPath[];
  counterparties: readonly string[];
  nodesVisited: number;
  truncated: boolean;
}

/** Direction value moves relative to the seed. */
export type FundFlowDirection = "outgoing" | "incoming";

/** Options for {@link traceFundFlow}. */
export interface FundFlowOptions {
  /** Maximum hops from the seed. Default: 4. */
  readonly maxDepth?: number;
  /** Ignore edges below this amount. Default: 0 (all non-negative edges). */
  readonly minAmount?: number;
  /** Maximum paths returned. Default: 100. */
  readonly maxPaths?: number;
  /** Maximum distinct accounts visited. Default: 1,000. */
  readonly maxNodes?: number;
  /** Follow payments away from or towards the seed. Default: outgoing. */
  readonly direction?: FundFlowDirection;
}

/** Bounded adjacency built from normalized transactions. */
export interface FundFlowGraph {
  hasNode(id: string): boolean;
  nodeIds(): string[];
  outEdges(id: string): readonly FundFlowEdge[];
  inEdges(id: string): readonly FundFlowEdge[];
  readonly truncated: boolean;
}

function requireAccount(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ValidationError(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function resolvePositive(value: number | undefined, fallback: number, label: string): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isInteger(value) || value < 0) {
    throw new ValidationError(`${label} must be a non-negative integer`);
  }
  return value;
}

function resolveAmount(value: number | undefined): number {
  if (value === undefined) {
    return 0;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new ValidationError("minAmount must be a non-negative finite number");
  }
  return value;
}

function canonicalAsset(transaction: Transaction): string {
  const code = transaction.assetCode?.trim();
  if (!code || code.toUpperCase() === "XLM") {
    return "XLM";
  }
  const issuer = transaction.assetIssuer?.trim();
  return issuer ? `${code}:${issuer}` : code;
}

/**
 * Builds a bounded fund-flow graph from normalized transactions (issue #13).
 *
 * Self-loops, malformed records and duplicate transaction ids are ignored.
 * A missing amount is treated as zero, which still allows topology tracing
 * while amount filters exclude it when configured.
 */
export function buildFundFlowGraph(
  transactions: readonly Transaction[],
  options: FundFlowOptions = {}
): FundFlowGraph {
  if (!Array.isArray(transactions)) {
    throw new ValidationError("transactions must be an array");
  }
  const maxNodes = resolvePositive(options.maxNodes, DEFAULT_MAX_TRACE_NODES, "maxNodes");
  const maxEdges = maxNodes * 4;
  const nodes = new Set<string>();
  const outgoing = new Map<string, FundFlowEdge[]>();
  const incoming = new Map<string, FundFlowEdge[]>();
  const seenIds = new Set<string>();
  let edgeCount = 0;
  let truncated = false;

  const ensure = (id: string): boolean => {
    if (nodes.has(id)) return true;
    if (nodes.size >= maxNodes) {
      truncated = true;
      return false;
    }
    nodes.add(id);
    outgoing.set(id, []);
    incoming.set(id, []);
    return true;
  };

  for (const transaction of transactions) {
    if (!transaction || typeof transaction !== "object") continue;
    const id = requireAccount(transaction.id, "transaction.id");
    const from = transaction.from ?? transaction.sourceAccount;
    const to = transaction.to;
    if (seenIds.has(id)) continue;
    if (
      typeof from !== "string" || from.length === 0 ||
      typeof to !== "string" || to.length === 0 ||
      from === to
    ) {
      continue;
    }
    if (!ensure(from) || !ensure(to)) continue;
    if (edgeCount >= maxEdges) {
      truncated = true;
      continue;
    }
    seenIds.add(id);
    const amount =
      typeof transaction.amount === "number" && Number.isFinite(transaction.amount)
        ? transaction.amount
        : 0;
    const edge: FundFlowEdge = {
      id,
      from,
      to,
      amount,
      asset: canonicalAsset(transaction),
      ...(typeof transaction.ledger === "number" ? { ledger: transaction.ledger } : {}),
      ...(typeof transaction.createdAt === "string" ? { occurredAt: transaction.createdAt } : {}),
    };
    (outgoing.get(from) as FundFlowEdge[]).push(edge);
    (incoming.get(to) as FundFlowEdge[]).push(edge);
    edgeCount += 1;
  }

  for (const list of outgoing.values()) {
    list.sort((left, right) => left.id.localeCompare(right.id));
  }
  for (const list of incoming.values()) {
    list.sort((left, right) => left.id.localeCompare(right.id));
  }

  return {
    hasNode: (id) => nodes.has(id),
    nodeIds: () => Array.from(nodes).sort(),
    outEdges: (id) => outgoing.get(id) ?? [],
    inEdges: (id) => incoming.get(id) ?? [],
    get truncated() {
      return truncated;
    },
  };
}

interface TraceState {
  readonly account: string;
  readonly hops: readonly FundFlowHop[];
  readonly visited: ReadonlySet<string>;
}

function buildPath(seed: string, hops: readonly FundFlowHop[]): FundFlowPath {
  const terminal = hops.length > 0 ? hops[hops.length - 1].account : seed;
  const assets = new Set(hops.map((hop) => hop.edge.asset));
  const asset =
    assets.size === 0 ? "XLM" : assets.size === 1 ? Array.from(assets)[0] : "mixed";
  const amount = hops.reduce((sum, hop) => sum + hop.edge.amount, 0);
  return {
    seed,
    hops,
    terminal,
    asset,
    totalAmount: Math.round(amount * 10_000) / 10_000,
  };
}

/**
 * Traces fund flow from a seed account.
 *
 * Returns one path per terminal reached before a depth, path or node cap.
 * Edges below `minAmount` are skipped; cycles are cut by the per-path visited
 * set. Paths are emitted in breadth-first, lexicographically sorted order so
 * repeated runs are byte-for-byte identical.
 */
export function traceFundFlow(
  graph: FundFlowGraph,
  seed: string,
  options: FundFlowOptions = {}
): FundFlowTrace {
  if (!graph || typeof graph.hasNode !== "function" || typeof graph.outEdges !== "function") {
    throw new ValidationError("A FundFlowGraph is required");
  }
  const account = requireAccount(seed, "seed");
  const maxDepth = resolvePositive(options.maxDepth, DEFAULT_MAX_TRACE_DEPTH, "maxDepth");
  const minAmount = resolveAmount(options.minAmount);
  const maxPaths = resolvePositive(options.maxPaths, DEFAULT_MAX_TRACE_PATHS, "maxPaths");
  const maxNodes = resolvePositive(options.maxNodes, DEFAULT_MAX_TRACE_NODES, "maxNodes");
  const direction = options.direction ?? "outgoing";
  if (direction !== "outgoing" && direction !== "incoming") {
    throw new ValidationError("direction must be 'outgoing' or 'incoming'");
  }

  const empty: FundFlowTrace = {
    seed: account,
    direction,
    maxDepth,
    minAmount,
    paths: [],
    counterparties: [],
    nodesVisited: graph.hasNode(account) ? 1 : 0,
    truncated: graph.truncated,
  };
  if (!graph.hasNode(account) || maxPaths === 0 || maxNodes === 0) {
    return { ...empty, truncated: empty.truncated || maxPaths === 0 || maxNodes === 0 };
  }

  const queue: TraceState[] = [{ account, hops: [], visited: new Set([account]) }];
  const paths: FundFlowPath[] = [];
  const visited = new Set<string>([account]);
  let truncated = graph.truncated;

  for (let index = 0; index < queue.length; index += 1) {
    const state = queue[index];
    const edges = direction === "outgoing"
      ? graph.outEdges(state.account)
      : graph.inEdges(state.account);
    const eligible = edges.filter((edge) => edge.amount >= minAmount);
    if (eligible.length === 0 || state.hops.length >= maxDepth) {
      paths.push(buildPath(account, state.hops));
      if (paths.length >= maxPaths) {
        if (index < queue.length - 1 || eligible.length > 0) truncated = true;
        break;
      }
      continue;
    }

    let extended = false;
    for (const edge of eligible) {
      const next = direction === "outgoing" ? edge.to : edge.from;
      if (state.visited.has(next)) continue;
      extended = true;
      const hop: FundFlowHop = {
        account: next,
        depth: state.hops.length + 1,
        edge,
        cumulativeAmount:
          Math.round((state.hops.reduce((sum, item) => sum + item.edge.amount, 0) + edge.amount) * 10_000) / 10_000,
      };
      const hops = [...state.hops, hop];
      if (hop.depth >= maxDepth) {
        paths.push(buildPath(account, hops));
        if (paths.length >= maxPaths) {
          truncated = true;
          break;
        }
        continue;
      }
      if (visited.size >= maxNodes) {
        truncated = true;
        continue;
      }
      visited.add(next);
      queue.push({ account: next, hops, visited: new Set([...state.visited, next]) });
    }
    if (!extended) {
      // Every outgoing edge looped back to an account already on this path.
      paths.push(buildPath(account, state.hops));
      if (paths.length >= maxPaths) {
        truncated = true;
        break;
      }
    }
    if (paths.length >= maxPaths) break;
  }

  paths.sort((left, right) => left.terminal.localeCompare(right.terminal));
  const counterparties = Array.from(
    new Set(paths.flatMap((path) => path.hops.map((hop) => hop.account)))
  ).sort();

  return {
    seed: account,
    direction,
    maxDepth,
    minAmount,
    paths,
    counterparties,
    nodesVisited: visited.size,
    truncated,
  };
}

/** Convenience helper: build the graph and trace in one call. */
export function traceFundFlowFromTransactions(
  transactions: readonly Transaction[],
  seed: string,
  options: FundFlowOptions = {}
): FundFlowTrace {
  return traceFundFlow(buildFundFlowGraph(transactions, options), seed, options);
}

export default traceFundFlow;
