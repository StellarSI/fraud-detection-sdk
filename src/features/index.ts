/**
 * Feature extraction families (issues #19, #20).
 *
 * Re-exports the shared provider contracts plus the velocity and graph
 * implementations so the registry (#24) and SDK consumers can import
 * them from one place.
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
