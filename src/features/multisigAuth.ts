/**
 * Multisig authorization-change feature extraction (issue #35).
 *
 * Multi-signature and clawback-enabled assets with unusual authorization
 * activity are a named detection area (README.md:24): `set_options`
 * operations that alter signers, thresholds, or clawback flags can
 * indicate account compromise or policy evasion. This module derives the
 * shared substrate for the multisig-authorization detector from the
 * normalized transaction history (#13) and the `set_options` details
 * carried by operation-enriched records.
 *
 * - **Signer changes** — signer entries altered by `set_options`
 *   operations: additions (weight > 0) and removals (weight 0).
 * - **Threshold changes** — operations that set low/medium/high
 *   thresholds. When previous thresholds are known from enrichment,
 *   reductions and increases are told apart.
 * - **Master weight changes** — operations that set the master weight;
 *   reductions are counted when the previous weight is known.
 * - **Flag changes** — `set_flags`/`clear_flags` covering account
 *   authorization flags: `auth_required`, `auth_revocable`,
 *   `auth_immutable`, and `clawback_enabled`.
 *
 * Contract:
 * - Only `set_options` transactions contribute. Transactions of any other
 *   type, or `set_options` transactions without enriched details, are
 *   tolerated silently.
 * - Empty histories yield zeroed features, never errors.
 * - Computation is deterministic: identical context, identical output.
 */

import type { Transaction } from "../clients/horizon.js";
import { ValidationError } from "../errors.js";
import type {
  FeatureContext,
  FeatureMap,
  FeatureProvider,
} from "./types.js";

/** Transaction types that carry authorization changes. */
export const SET_OPTIONS_TYPES: readonly string[] = ["set_options"] as const;

/** Authorization flags counted as authorization changes. */
export const AUTH_FLAGS: readonly string[] = [
  "auth_required",
  "auth_revocable",
  "auth_immutable",
] as const;

/** Flag that marks clawback-enabled assets. */
export const CLAWBACK_ENABLED_FLAG = "clawback_enabled";

/** Options for {@link extractMultisigAuthFeatures}. */
export interface MultisigAuthOptions {
  /** Account being scored (unused; kept for provider symmetry). */
  readonly accountId?: string;
}

/** Multisig authorization-change features for one account history. */
export interface MultisigAuthFeatures {
  /** `set_options` operations observed in the history. */
  readonly setOptionsCount: number;
  /** `set_options` operations carrying signer changes. */
  readonly signerOperationCount: number;
  /** Signer entries added or updated with a non-zero weight. */
  readonly signerAddedCount: number;
  /** Signer entries removed (weight 0). */
  readonly signerRemovedCount: number;
  /** `set_options` operations setting low/medium/high thresholds. */
  readonly thresholdChangeCount: number;
  /** Threshold operations where at least one bound decreased (previous known). */
  readonly thresholdReductionCount: number;
  /** Threshold operations where no bound decreased but at least one increased. */
  readonly thresholdIncreaseCount: number;
  /** `set_options` operations setting the master weight. */
  readonly masterWeightChangeCount: number;
  /** Master-weight operations where the weight decreased (previous known). */
  readonly masterWeightReductionCount: number;
  /** `set_options` operations enabling the clawback flag. */
  readonly clawbackEnabledCount: number;
  /** `set_options` operations disabling the clawback flag. */
  readonly clawbackDisabledCount: number;
  /** `set_options` operations changing auth_required/revocable/immutable. */
  readonly authFlagChangeCount: number;
}

function isSetOptionsTransaction(transaction: Transaction): boolean {
  const type = typeof transaction.type === "string" ? transaction.type.trim().toLowerCase() : "";
  return SET_OPTIONS_TYPES.includes(type);
}

function normalizeFlag(flag: string): string {
  return flag.trim().toLowerCase();
}

function compareThresholds(
  current: { readonly low?: number; readonly medium?: number; readonly high?: number } | undefined,
  previous: { readonly low?: number; readonly medium?: number; readonly high?: number } | undefined
): { reduced: boolean; increased: boolean } {
  let reduced = false;
  let increased = false;
  if (!current) {
    return { reduced, increased };
  }
  const bounds = ["low", "medium", "high"] as const;
  for (const bound of bounds) {
    const next = current[bound];
    if (typeof next !== "number" || !Number.isFinite(next)) {
      continue;
    }
    const prior = previous?.[bound];
    if (typeof prior !== "number" || !Number.isFinite(prior)) {
      continue;
    }
    if (next < prior) {
      reduced = true;
    } else if (next > prior) {
      increased = true;
    }
  }
  return { reduced, increased };
}

/**
 * Computes multisig authorization-change features from a normalized
 * transaction history.
 *
 * @param transactions - Normalized transactions (issue #13), possibly
 *   carrying `setOptions` details from operation-enriched records.
 * @param options - Reserved for symmetry with other feature families.
 * @returns Deterministic {@link MultisigAuthFeatures}.
 * @throws {ValidationError} If `transactions` is not an array.
 */
export function extractMultisigAuthFeatures(
  transactions: readonly Transaction[],
  options: MultisigAuthOptions = {}
): MultisigAuthFeatures {
  if (!Array.isArray(transactions)) {
    throw new ValidationError("transactions must be an array");
  }
  // `options` is accepted for symmetry; only array shape is validated today.
  void options;

  let setOptionsCount = 0;
  let signerOperationCount = 0;
  let signerAddedCount = 0;
  let signerRemovedCount = 0;
  let thresholdChangeCount = 0;
  let thresholdReductionCount = 0;
  let thresholdIncreaseCount = 0;
  let masterWeightChangeCount = 0;
  let masterWeightReductionCount = 0;
  let clawbackEnabledCount = 0;
  let clawbackDisabledCount = 0;
  let authFlagChangeCount = 0;

  for (const transaction of transactions) {
    if (!transaction || typeof transaction !== "object") {
      continue;
    }
    if (!isSetOptionsTransaction(transaction)) {
      continue;
    }
    setOptionsCount += 1;

    const details = transaction.setOptions;
    if (!details || typeof details !== "object") {
      continue;
    }

    // Signers: weight 0 reads as a removal, anything else as an addition.
    const signers = Array.isArray(details.signers) ? details.signers : [];
    let touchedSigners = 0;
    for (const signer of signers) {
      if (!signer || typeof signer !== "object") {
        continue;
      }
      touchedSigners += 1;
      const weight =
        typeof signer.weight === "number" && Number.isFinite(signer.weight)
          ? signer.weight
          : undefined;
      if (weight === 0) {
        signerRemovedCount += 1;
      } else {
        signerAddedCount += 1;
      }
    }
    if (touchedSigners > 0) {
      signerOperationCount += 1;
    }

    // Thresholds: compare against previous values when enrichment carries them.
    const thresholds = details.thresholds;
    if (thresholds && typeof thresholds === "object") {
      const hasBound = [thresholds.low, thresholds.medium, thresholds.high].some(
        (value) => typeof value === "number" && Number.isFinite(value)
      );
      if (hasBound) {
        thresholdChangeCount += 1;
        const { reduced, increased } = compareThresholds(
          thresholds,
          details.previousThresholds
        );
        if (reduced) {
          thresholdReductionCount += 1;
        } else if (increased) {
          thresholdIncreaseCount += 1;
        }
      }
    }

    // Master weight: reduction only when the previous weight is known.
    const masterWeight = details.masterWeight;
    if (typeof masterWeight === "number" && Number.isFinite(masterWeight)) {
      masterWeightChangeCount += 1;
      const previous = details.previousMasterWeight;
      if (
        typeof previous === "number" &&
        Number.isFinite(previous) &&
        masterWeight < previous
      ) {
        masterWeightReductionCount += 1;
      }
    }

    // Flags: clawback enablement and authorization flag changes.
    const setFlags = Array.isArray(details.setFlags)
      ? details.setFlags.filter((flag: unknown): flag is string => typeof flag === "string")
      : [];
    const clearFlags = Array.isArray(details.clearFlags)
      ? details.clearFlags.filter((flag: unknown): flag is string => typeof flag === "string")
      : [];
    const normalizedSet = new Set(setFlags.map(normalizeFlag));
    const normalizedClear = new Set(clearFlags.map(normalizeFlag));

    if (normalizedSet.has(CLAWBACK_ENABLED_FLAG)) {
      clawbackEnabledCount += 1;
    }
    if (normalizedClear.has(CLAWBACK_ENABLED_FLAG)) {
      clawbackDisabledCount += 1;
    }
    const authChanged = AUTH_FLAGS.some(
      (flag) => normalizedSet.has(flag) || normalizedClear.has(flag)
    );
    if (authChanged) {
      authFlagChangeCount += 1;
    }
  }

  return {
    setOptionsCount,
    signerOperationCount,
    signerAddedCount,
    signerRemovedCount,
    thresholdChangeCount,
    thresholdReductionCount,
    thresholdIncreaseCount,
    masterWeightChangeCount,
    masterWeightReductionCount,
    clawbackEnabledCount,
    clawbackDisabledCount,
    authFlagChangeCount,
  };
}

/**
 * Flattens multisig authorization-change features into the registry's
 * uniform map (#24).
 *
 * @param features - Output of {@link extractMultisigAuthFeatures}.
 */
export function multisigAuthFeaturesToFeatureMap(
  features: MultisigAuthFeatures
): FeatureMap {
  return {
    setOptionsCount: features.setOptionsCount,
    signerOperationCount: features.signerOperationCount,
    signerAddedCount: features.signerAddedCount,
    signerRemovedCount: features.signerRemovedCount,
    thresholdChangeCount: features.thresholdChangeCount,
    thresholdReductionCount: features.thresholdReductionCount,
    thresholdIncreaseCount: features.thresholdIncreaseCount,
    masterWeightChangeCount: features.masterWeightChangeCount,
    masterWeightReductionCount: features.masterWeightReductionCount,
    clawbackEnabledCount: features.clawbackEnabledCount,
    clawbackDisabledCount: features.clawbackDisabledCount,
    authFlagChangeCount: features.authFlagChangeCount,
  };
}

/** Options for {@link createMultisigAuthFeatureProvider}. */
export interface MultisigAuthProviderOptions extends MultisigAuthOptions {}

/**
 * Creates a registry-ready multisig authorization provider (#35, #24).
 *
 * The provider reads the normalized history (#13); `context.accountId`
 * is accepted for symmetry with the other providers.
 */
export function createMultisigAuthFeatureProvider(
  options: MultisigAuthProviderOptions = {}
): FeatureProvider {
  return {
    name: "multisig-auth",
    compute(context: FeatureContext): FeatureMap {
      if (!context || typeof context !== "object" || !Array.isArray(context.transactions)) {
        throw new ValidationError(
          "Multisig features require FeatureContext.transactions (issue #13)"
        );
      }
      const features = extractMultisigAuthFeatures(context.transactions, {
        ...options,
        accountId: context.accountId ?? options.accountId,
      });
      return multisigAuthFeaturesToFeatureMap(features);
    },
  };
}
