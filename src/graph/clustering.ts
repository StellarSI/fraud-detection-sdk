/**
 * Counterparty clustering (issue #44).
 *
 * Counterparty clustering is a named graph feature in the README: it finds
 * groups of accounts that transact tightly among themselves. Such groups
 * often represent coordinated actors (a fraud ring), so this module turns
 * the bounded counterparty graph (#20, #46) into stable cluster membership,
 * per-cluster size/density, and a `counterparty-cluster` signal input.
 *
 * Contract:
 * - The partition strategy is pluggable via {@link ClusteringAlgorithm};
 *   connected components and label propagation ship as built-ins.
 * - Output is deterministic: nodes and members are sorted, and tie-breaks
 *   are resolved lexicographically.
 * - Missing accounts produce zeroed features, never errors.
 * - Bounds from the underlying graph are reported, not hidden.
 */

import { ValidationError } from "../errors.js";
import {
  buildCounterpartyGraph,
  type CounterpartyGraph,
} from "../features/graph.js";
import type {
  FeatureContext,
  FeatureMap,
  FeatureProvider,
} from "../features/types.js";

/** Minimum number of accounts before a cluster can be called tight. */
export const DEFAULT_MIN_CLUSTER_SIZE = 3;

/** Minimum internal edge density before a cluster can be called tight. */
export const DEFAULT_MIN_CLUSTER_DENSITY = 0.75;

/** Iteration cap for label propagation. */
export const DEFAULT_MAX_LABEL_ITERATIONS = 32;

/** A group of accounts that transact tightly among themselves. */
export interface CounterpartyCluster {
  /** Stable, deterministic identifier derived from the sorted membership. */
  readonly id: string;
  /** Sorted account IDs belonging to this cluster. */
  readonly members: readonly string[];
  /** Number of accounts in the cluster. */
  readonly size: number;
  /** Distinct undirected edges with both endpoints in the cluster. */
  readonly internalEdges: number;
  /** internalEdges / (size * (size - 1) / 2), in [0, 1]. */
  readonly density: number;
  /** True when size and density both clear the configured thresholds. */
  readonly tight: boolean;
}

/**
 * Pluggable partition strategy (issue #44).
 *
 * An implementation only decides which accounts belong together; cluster
 * metrics are computed centrally by {@link computeClusters} so every
 * strategy exposes the same membership/size/density surface.
 */
export interface ClusteringAlgorithm {
  /** Stable strategy name, reported in the feature map. */
  readonly name: string;
  /** Returns one group of account IDs per cluster. */
  partition(graph: CounterpartyGraph): readonly (readonly string[])[];
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function resolvePositiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new ValidationError(`${label} must be a positive integer`);
  }
  return value;
}

function resolveDensity(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new ValidationError(`${label} must be a finite number in [0, 1]`);
  }
  return value;
}

/**
 * Connected-components partition over the undirected graph projection.
 *
 * Every account reachable through any counterparty chain lands in one
 * cluster. This is the conservative default: it never splits a community,
 * but it can join loosely connected components (for example a star) into a
 * large group, which density then filters out.
 */
export class ConnectedComponentsClustering implements ClusteringAlgorithm {
  readonly name = "connected-components";

  partition(graph: CounterpartyGraph): readonly (readonly string[])[] {
    const visited = new Set<string>();
    const groups: string[][] = [];

    for (const node of graph.nodes()) {
      if (visited.has(node)) {
        continue;
      }
      const group: string[] = [];
      const queue: string[] = [node];
      visited.add(node);

      for (let index = 0; index < queue.length; index += 1) {
        const current = queue[index];
        group.push(current);
        for (const neighbor of graph.neighbors(current)) {
          if (!visited.has(neighbor)) {
            visited.add(neighbor);
            queue.push(neighbor);
          }
        }
      }
      groups.push(group.sort());
    }

    return groups;
  }
}

/**
 * Asynchronous label propagation over the undirected projection.
 *
 * Each account starts with its own label and repeatedly adopts the most
 * common label among its counterparties (lexicographic tie-break). Labels
 * are updated in place in sorted node order: the earlier nodes in a sweep
 * are visible to later ones, which converges instead of oscillating on a
 * 2-node component (synchronous updates swap two labels forever there).
 * Iteration stops early once no label changes, and sorted traversal keeps
 * the result independent of node insertion order.
 */
export class LabelPropagationClustering implements ClusteringAlgorithm {
  readonly name = "label-propagation";
  private readonly maxIterations: number;

  constructor(maxIterations: number = DEFAULT_MAX_LABEL_ITERATIONS) {
    this.maxIterations = resolvePositiveInteger(
      maxIterations,
      "maxIterations"
    );
  }

  partition(graph: CounterpartyGraph): readonly (readonly string[])[] {
    const nodes = graph.nodes();
    const labels = new Map<string, string>();
    for (const node of nodes) {
      labels.set(node, node);
    }

    for (let iteration = 0; iteration < this.maxIterations; iteration += 1) {
      let changed = false;
      for (const node of nodes) {
        const counts = new Map<string, number>();
        for (const neighbor of graph.neighbors(node)) {
          const label = labels.get(neighbor);
          if (label !== undefined) {
            counts.set(label, (counts.get(label) ?? 0) + 1);
          }
        }

        let winner: string | undefined;
        let winnerCount = -1;
        for (const [label, count] of counts) {
          if (count > winnerCount || (count === winnerCount && label < (winner ?? ""))) {
            winner = label;
            winnerCount = count;
          }
        }
        if (winner !== undefined && winner !== labels.get(node)) {
          labels.set(node, winner);
          changed = true;
        }
      }
      if (!changed) {
        break;
      }
    }

    const groups = new Map<string, string[]>();
    for (const node of nodes) {
      const label = labels.get(node) ?? node;
      const group = groups.get(label) ?? [];
      group.push(node);
      groups.set(label, group);
    }

    return Array.from(groups.values())
      .map((group) => group.sort())
      .sort((left, right) => left[0].localeCompare(right[0]));
  }
}

/** Options for {@link computeClusters} and the clustering feature provider. */
export interface ClusteringOptions {
  /** Partition strategy. Default: connected components. */
  readonly algorithm?: ClusteringAlgorithm;
  /** Minimum cluster size for `tight`. Default: 3. */
  readonly minClusterSize?: number;
  /** Minimum internal density for `tight`. Default: 0.75. */
  readonly minClusterDensity?: number;
  /** Maximum graph nodes retained by the provider. */
  readonly maxNodes?: number;
  /** Maximum graph edges retained by the provider. */
  readonly maxEdges?: number;
}

function describeCluster(
  group: readonly string[],
  graph: CounterpartyGraph,
  minSize: number,
  minDensity: number
): CounterpartyCluster {
  const members = Array.from(new Set(group.filter((node) => graph.hasNode(node)))).sort();
  const memberSet = new Set<string>(members);
  let internalEdges = 0;
  for (const member of members) {
    for (const neighbor of graph.neighbors(member)) {
      if (memberSet.has(neighbor)) {
        internalEdges += 1;
      }
    }
  }
  internalEdges /= 2;

  const possibleEdges = members.length > 1 ? (members.length * (members.length - 1)) / 2 : 0;
  const density = possibleEdges > 0 ? round4(internalEdges / possibleEdges) : 0;

  return {
    id: `cluster:${members.join("|")}`,
    members,
    size: members.length,
    internalEdges,
    density,
    tight: members.length >= minSize && density >= minDensity,
  };
}

/**
 * Partitions a counterparty graph into described clusters.
 *
 * @throws {ValidationError} If the graph or an option is invalid.
 */
export function computeClusters(
  graph: CounterpartyGraph,
  options: ClusteringOptions = {}
): CounterpartyCluster[] {
  if (!graph || typeof graph.nodes !== "function" || typeof graph.neighbors !== "function") {
    throw new ValidationError("A CounterpartyGraph is required");
  }
  const algorithm = options.algorithm ?? new ConnectedComponentsClustering();
  if (!algorithm || typeof algorithm.partition !== "function") {
    throw new ValidationError("algorithm must implement partition(graph)");
  }
  const minSize = options.minClusterSize === undefined
    ? DEFAULT_MIN_CLUSTER_SIZE
    : resolvePositiveInteger(options.minClusterSize, "minClusterSize");
  const minDensity = options.minClusterDensity === undefined
    ? DEFAULT_MIN_CLUSTER_DENSITY
    : resolveDensity(options.minClusterDensity, "minClusterDensity");

  return algorithm
    .partition(graph)
    .map((group) => describeCluster(group, graph, minSize, minDensity))
    .sort((left, right) => right.size - left.size || left.id.localeCompare(right.id));
}

/** Returns the cluster containing `accountId`, or null when it has none. */
export function clusterForAccount(
  clusters: readonly CounterpartyCluster[],
  accountId: string
): CounterpartyCluster | null {
  if (typeof accountId !== "string" || accountId.length === 0) {
    return null;
  }
  for (const cluster of clusters) {
    if (cluster.members.includes(accountId)) {
      return cluster;
    }
  }
  return null;
}

/** Per-account clustering features. */
export interface ClusteringFeatures {
  /** Stable cluster id; empty string when the account is absent. */
  readonly clusterId: string;
  /** Number of accounts in the cluster. */
  readonly clusterSize: number;
  /** Internal edge density of the cluster, in [0, 1]. */
  readonly clusterDensity: number;
  /** True when the account belongs to a tight cluster. */
  readonly clusterIsTight: boolean;
  /** Total number of clusters found in the graph. */
  readonly clusterCount: number;
  /** Name of the partition strategy used. */
  readonly clusterAlgorithm: string;
  /** True when the bounded graph dropped nodes or edges. */
  readonly clusterTruncated: boolean;
}

/** Extracts clustering features for one account from a counterparty graph. */
export function extractClusteringFeatures(
  graph: CounterpartyGraph,
  accountId: string,
  options: ClusteringOptions = {}
): ClusteringFeatures {
  const clusters = computeClusters(graph, options);
  const cluster = clusterForAccount(clusters, accountId);
  const algorithm = options.algorithm ?? new ConnectedComponentsClustering();

  return {
    clusterId: cluster?.id ?? "",
    clusterSize: cluster?.size ?? 0,
    clusterDensity: cluster?.density ?? 0,
    clusterIsTight: cluster?.tight ?? false,
    clusterCount: clusters.length,
    clusterAlgorithm: algorithm.name,
    clusterTruncated: graph.truncated,
  };
}

/** Flattens clustering features into the registry's uniform map (#24). */
export function clusteringFeaturesToFeatureMap(
  features: ClusteringFeatures
): FeatureMap {
  return {
    clusterId: features.clusterId,
    clusterSize: features.clusterSize,
    clusterDensity: features.clusterDensity,
    clusterIsTight: features.clusterIsTight,
    clusterCount: features.clusterCount,
    clusterAlgorithm: features.clusterAlgorithm,
    clusterTruncated: features.clusterTruncated,
  };
}

/** Creates a registry-ready counterparty-clustering provider (#24, #44). */
export function createClusteringFeatureProvider(
  options: ClusteringOptions = {}
): FeatureProvider {
  return {
    name: "counterparty-clustering",
    compute(context: FeatureContext): FeatureMap {
      if (!Array.isArray(context?.transactions)) {
        throw new ValidationError(
          "Clustering features require FeatureContext.transactions (issue #13)"
        );
      }
      const graph = buildCounterpartyGraph(context.transactions, {
        maxNodes: options.maxNodes,
        maxEdges: options.maxEdges,
      });
      const accountId = typeof context.accountId === "string" ? context.accountId : "";
      return clusteringFeaturesToFeatureMap(
        extractClusteringFeatures(graph, accountId, options)
      );
    },
  };
}

export default computeClusters;
