/**
 * Multisig authorization-change detector rule (issue #35).
 *
 * `set_options` operations that alter signers, thresholds, master weight,
 * or clawback/authorization flags are the control plane of a Stellar
 * account: unusual changes can indicate account compromise or policy
 * evasion (README.md:24). Consumes multisig authorization-change
 * features (#35) — derived from the normalized history (#13) and the
 * `set_options` details of operation-enriched records — and emits a
 * `multisig-authorization` signal whose weight scales with the
 * suspicious changes observed.
 *
 * Each change type can be enabled or disabled independently so operators
 * can tune the alert surface per environment. Benign authorization
 * activity — signer additions, threshold increases, clawback removal —
 * stays quiet by default.
 */

import type { Signal } from "../types.js";
import type { Rule, RuleContext } from "./engine.js";
import { ValidationError } from "../errors.js";

/** Default rule weight (engine contribution) in [0, 1]. */
export const DEFAULT_MULTISIG_AUTHORIZATION_RULE_WEIGHT = 0.6;

/** Default minimum severity required to emit a signal. */
export const DEFAULT_MULTISIG_AUTHORIZATION_MIN_SCORE = 0.05;

export interface MultisigAuthorizationRuleOptions {
  /**
   * Base rule weight (engine contribution) in [0, 1].
   * The emitted signal weight scales by severity; the engine combines them.
   */
  readonly weight?: number;
  /** Minimum severity score required to emit a signal. Default: 0.05. */
  readonly minScore?: number;
  /** Flag signer removals (weight 0). Default: true. */
  readonly enableSignerRemoval?: boolean;
  /** Flag signer additions (weight > 0). Default: false (benign by default). */
  readonly enableSignerAddition?: boolean;
  /** Flag threshold reductions (previous values known). Default: true. */
  readonly enableThresholdReduction?: boolean;
  /** Flag threshold increases (previous values known). Default: false. */
  readonly enableThresholdIncrease?: boolean;
  /** Flag master weight reductions (previous value known). Default: true. */
  readonly enableMasterWeightReduction?: boolean;
  /** Flag clawback flag enablement. Default: true. */
  readonly enableClawbackEnablement?: boolean;
  /** Flag clawback flag removal. Default: false. */
  readonly enableClawbackDisable?: boolean;
  /** Flag auth_required/auth_revocable/auth_immutable changes. Default: true. */
  readonly enableAuthFlagChange?: boolean;
}

function resolveNumber(
  value: number | undefined,
  fallback: number,
  label: string
): number {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ValidationError(`${label} must be a finite number`);
  }
  return value;
}

function resolveBoolean(
  value: boolean | undefined,
  fallback: boolean,
  label: string
): boolean {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "boolean") {
    throw new ValidationError(`${label} must be a boolean`);
  }
  return value;
}

function num(context: RuleContext, key: string): number {
  const value = context[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }
  if (value >= 1) {
    return 1;
  }
  return Math.round(value * 10_000) / 10_000;
}

/**
 * Creates the multisig authorization-change rule.
 *
 * Reads features produced by `extractMultisigAuthFeatures` /
 * `createMultisigAuthFeatureProvider` (#35): `setOptionsCount`,
 * `signerAddedCount`, `signerRemovedCount`, `thresholdChangeCount`,
 * `thresholdReductionCount`, `thresholdIncreaseCount`,
 * `masterWeightReductionCount`, `clawbackEnabledCount`,
 * `clawbackDisabledCount`, and `authFlagChangeCount`.
 *
 * Authorization changes are scored per change type; each enabled type
 * adds a fixed contribution plus a small bump per additional occurrence.
 * Accounts with no `set_options` activity — or only benign, disabled
 * change types — emit nothing.
 */
export function createMultisigAuthorizationRule(
  options: MultisigAuthorizationRuleOptions = {}
): Rule {
  const weight = resolveNumber(
    options.weight,
    DEFAULT_MULTISIG_AUTHORIZATION_RULE_WEIGHT,
    "weight"
  );
  const minScore = resolveNumber(
    options.minScore,
    DEFAULT_MULTISIG_AUTHORIZATION_MIN_SCORE,
    "minScore"
  );
  if (minScore < 0 || minScore > 1) {
    throw new ValidationError("minScore must be in [0, 1]");
  }
  const enableSignerRemoval = resolveBoolean(
    options.enableSignerRemoval,
    true,
    "enableSignerRemoval"
  );
  const enableSignerAddition = resolveBoolean(
    options.enableSignerAddition,
    false,
    "enableSignerAddition"
  );
  const enableThresholdReduction = resolveBoolean(
    options.enableThresholdReduction,
    true,
    "enableThresholdReduction"
  );
  const enableThresholdIncrease = resolveBoolean(
    options.enableThresholdIncrease,
    false,
    "enableThresholdIncrease"
  );
  const enableMasterWeightReduction = resolveBoolean(
    options.enableMasterWeightReduction,
    true,
    "enableMasterWeightReduction"
  );
  const enableClawbackEnablement = resolveBoolean(
    options.enableClawbackEnablement,
    true,
    "enableClawbackEnablement"
  );
  const enableClawbackDisable = resolveBoolean(
    options.enableClawbackDisable,
    false,
    "enableClawbackDisable"
  );
  const enableAuthFlagChange = resolveBoolean(
    options.enableAuthFlagChange,
    true,
    "enableAuthFlagChange"
  );
  if (
    !enableSignerRemoval &&
    !enableSignerAddition &&
    !enableThresholdReduction &&
    !enableThresholdIncrease &&
    !enableMasterWeightReduction &&
    !enableClawbackEnablement &&
    !enableClawbackDisable &&
    !enableAuthFlagChange
  ) {
    throw new ValidationError(
      "at least one change type must be enabled (enable* options)"
    );
  }

  return {
    id: "multisig-authorization",
    weight,
    evaluate(context: RuleContext): Signal | null {
      const setOptionsCount = num(context, "setOptionsCount");
      if (setOptionsCount <= 0) {
        return null;
      }

      const signerAdded = num(context, "signerAddedCount");
      const signerRemoved = num(context, "signerRemovedCount");
      const thresholdReduction = num(context, "thresholdReductionCount");
      const thresholdIncrease = num(context, "thresholdIncreaseCount");
      const thresholdChanges = num(context, "thresholdChangeCount");
      const masterWeightReduction = num(context, "masterWeightReductionCount");
      const clawbackEnabled = num(context, "clawbackEnabledCount");
      const clawbackDisabled = num(context, "clawbackDisabledCount");
      const authFlagChange = num(context, "authFlagChangeCount");

      const reasons: string[] = [];
      let severity = 0;

      // Signer removals: the clearest compromise indicator.
      if (enableSignerRemoval && signerRemoved > 0) {
        severity += 0.4 + 0.15 * Math.min(signerRemoved - 1, 2);
        reasons.push(
          `${signerRemoved} signer removal${signerRemoved === 1 ? "" : "s"}`
        );
      }
      // Master weight reduction: weakens the account's own signature.
      if (enableMasterWeightReduction && masterWeightReduction > 0) {
        severity += 0.25 + 0.1 * Math.min(masterWeightReduction - 1, 2);
        reasons.push(
          `master weight reduced ${masterWeightReduction} time${
            masterWeightReduction === 1 ? "" : "s"
          }`
        );
      }
      // Threshold reductions: lower the bar for valid authorization.
      if (enableThresholdReduction && thresholdReduction > 0) {
        severity += 0.3 + 0.15 * Math.min(thresholdReduction - 1, 2);
        reasons.push(
          `${thresholdReduction} threshold reduction${
            thresholdReduction === 1 ? "" : "s"
          }`
        );
      }
      // Clawback enablement: new confiscation capability on the account.
      if (enableClawbackEnablement && clawbackEnabled > 0) {
        severity += 0.35 + 0.1 * Math.min(clawbackEnabled - 1, 2);
        reasons.push(
          `clawback enabled${clawbackEnabled > 1 ? ` ${clawbackEnabled} time(s)` : ""}`
        );
      }
      // Authorization flag changes: required/revocable/immutable flips.
      if (enableAuthFlagChange && authFlagChange > 0) {
        severity += 0.2 + 0.1 * Math.min(authFlagChange - 1, 2);
        reasons.push(
          `${authFlagChange} authorization flag change${
            authFlagChange === 1 ? "" : "s"
          }`
        );
      }
      // Disabled by default: benign or ambiguous changes.
      if (enableSignerAddition && signerAdded > 0) {
        severity += 0.15 + 0.05 * Math.min(signerAdded - 1, 2);
        reasons.push(
          `${signerAdded} signer addition${signerAdded === 1 ? "" : "s"}`
        );
      }
      if (enableThresholdIncrease && thresholdIncrease > 0) {
        severity += 0.1 + 0.05 * Math.min(thresholdIncrease - 1, 2);
        reasons.push(
          `${thresholdIncrease} threshold increase${
            thresholdIncrease === 1 ? "" : "s"
          }`
        );
      }
      if (enableClawbackDisable && clawbackDisabled > 0) {
        severity += 0.1 + 0.05 * Math.min(clawbackDisabled - 1, 2);
        reasons.push(
          `clawback disabled${clawbackDisabled > 1 ? ` ${clawbackDisabled} time(s)` : ""}`
        );
      }

      if (reasons.length === 0) {
        // Benign or disabled change types only.
        return null;
      }

      severity = clamp01(severity);
      if (severity < minScore) {
        return null;
      }

      return {
        id: "multisig-authorization",
        weight: Math.round(Math.min(Math.max(severity, 0), 1) * 10_000) / 10_000,
        detail:
          `Multisig authorization change indicators: ${reasons.join(", ")} ` +
          `across ${setOptionsCount} set_options operation(s)` +
          (thresholdChanges > 0 && thresholdReduction === 0
            ? ` (${thresholdChanges} threshold change(s) without reduction)`
            : ""),
      };
    },
  };
}

export default createMultisigAuthorizationRule;
