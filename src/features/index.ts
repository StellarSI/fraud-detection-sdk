/**
 * Feature extraction families (issues #19, #20, #21, #22, #23).
 *
 * Re-exports the shared provider contracts plus the velocity, graph,
 * asset, memo, and lifecycle implementations so the registry (#24) and
 * SDK consumers can import them from one place.
 */

export type {
  FeatureContext,
  FeatureMap,
  FeatureProvider,
  FeatureValue,
} from "./types.js";

export {
  DEFAULT_VELOCITY_WINDOWS,
  extractVelocityFeatures,
  velocityFeaturesToFeatureMap,
  createVelocityFeatureProvider,
} from "./velocity.js";
export type {
  VelocityFeatures,
  VelocityOptions,
  VelocityWindow,
} from "./velocity.js";

export {
  CounterpartyGraph,
  DEFAULT_MAX_GRAPH_NODES,
  DEFAULT_MAX_GRAPH_EDGES,
  DEFAULT_MAX_CLUSTERING_DEGREE,
  buildCounterpartyGraph,
  extractGraphFeatures,
  graphFeaturesToFeatureMap,
  createGraphFeatureProvider,
} from "./graph.js";
export type {
  CounterpartyGraphOptions,
  GraphFeatureOptions,
  GraphFeatures,
} from "./graph.js";

export {
  DEFAULT_TRUSTLINE_CHURN_WINDOW_MS,
  NATIVE_ASSET_ID,
  canonicalAssetId,
  extractAssetFeatures,
  assetFeaturesToFeatureMap,
  createAssetFeatureProvider,
} from "./assets.js";
export type {
  AssetFeatures,
  AssetFeatureOptions,
} from "./assets.js";

export {
  DEFAULT_MAX_MEMO_LENGTH,
  MEMO_VARIANTS,
  sanitizeMemo,
  normalizeMemoType,
  isValidMemoValue,
  extractMemoFeatures,
  memoFeaturesToFeatureMap,
  createMemoFeatureProvider,
} from "./memo.js";
export type {
  MemoFeatures,
  MemoFeatureOptions,
  MemoEntry,
  MemoType,
} from "./memo.js";

export {
  DEFAULT_RAPID_MERGE_WINDOW_MS,
  extractLifecycleFeatures,
  lifecycleFeaturesToFeatureMap,
  createLifecycleFeatureProvider,
} from "./lifecycle.js";
export type {
  LifecycleFeatures,
  LifecycleOptions,
} from "./lifecycle.js";

export {
  FeatureRegistry,
  createFeatureRegistry,
  createDefaultFeatureRegistry,
  createDefaultFeatureProviders,
  extractFeatures,
} from "./registry.js";
export type { FeatureRegistryOptions } from "./registry.js";
