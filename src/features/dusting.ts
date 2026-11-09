/**
 * Dusting feature extraction (issue #28).
 *
 * "Dusting" (README.md) refers to sending tiny amounts to many accounts
 * to deanonymize or spam recipients. This module identifies outbound
 * payments below a configurable dust threshold to distinct counterparties
 * from the normalized transaction history (#13) so the dusting rule can
 * emit scaled, explainable signals.
 *
 * Contract:
 * - The scored account is required: outbound attribution without an
 *   account id is meaningless, so a missing id is a `ValidationError`.
 * - Only outbound `payment` operations from the scored account are
 *   considered dust candidates.
 * - Asset and volume context is reported so rules can distinguish
 *   legitimate bulk micro-disbursements.
 * - Empty histories yield zeroed features, never errors.
 * - Identical input yields identical output.
 */

import type { Transaction } from "../clients/horizon.js";
import { ValidationError } from "../errors.js";
import type {
  FeatureContext,
  FeatureMap,
  FeatureProvider,
} from "./types.js";

/** Default maximum amount (inclusive) treated as "dust". */
export const DEFAULT_DUST_THRESHOLD = 0.01;

/** Options for {@link extractDustingFeatures}. */
export interface DustingOptions {
  /** Account whose outbound payments are analyzed (required). */
  readonly accountId?: string;
  /** Maximum payment amount treated as dust. Default: 0.01. */
  readonly dustThreshold?: number;
}

/** Per-account dusting features. */
export interface DustingFeatures {
  /** Outbound dust payments (amount > 0 and <= dustThreshold). */
  readonly dustPaymentCount: number;
  /** Distinct recipients that received dust payments. */
  readonly dustRecipientCount: number;
  /** Sum of dust payment amounts. */
  readonly dustTotalVolume: number;
  /** Average dust payment amount (0 when none). */
  readonly dustAverageAmount: number;
  /** Distinct asset ids among dust payments. */
  readonly dustAssetDiversity: number;
  /** Total outbound payment operations considered. */
  readonly outboundPaymentCount: number;
  /** Severity in [0, 1] scaled by recipient count and dust volume. */
  readonly dustingScore: number;
  /** The dust threshold applied. */
  readonly dustThreshold: number;
}

function resolveAccountId(accountId: string | undefined): string {
  if (typeof accountId !== "string" || accountId.trim().length === 0) {
    throw new ValidationError(
      "dusting features require the scored accountId (context.accountId or context.account.id)"
    );
  }
  return accountId.trim();
}

function resolveDustThreshold(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_DUST_THRESHOLD;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new ValidationError("dustThreshold must be a positive finite number");
  }
  return value;
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

function operationType(transaction: Transaction): string {
  return String(transaction.type ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

function assetId(transaction: Transaction): string {
  const code =
    typeof transaction.assetCode === "string" && transaction.assetCode.trim().length > 0
      ? transaction.assetCode.trim().toUpperCase()
      : "XLM";
  const issuer =
    typeof transaction.assetIssuer === "string" && transaction.assetIssuer.trim().length > 0
      ? transaction.assetIssuer.trim()
      : "";
  return issuer.length > 0 ? `${code}:${issuer}` : code;
}

function isOutboundPayment(transaction: Transaction, accountId: string): boolean {
  if (operationType(transaction) !== "payment") {
    return false;
  }
  const sender = transaction.from ?? transaction.sourceAccount;
  return typeof sender === "string" && sender === accountId;
}

/**
 * Computes dusting features from a normalized transaction history.
 *
 * @param transactions - Normalized transactions (issue #13).
 * @param options - Scored account (required) and dust threshold.
 * @returns Deterministic {@link DustingFeatures}.
 * @throws {ValidationError} If the account id or options are invalid.
 */
export function extractDustingFeatures(
  transactions: readonly Transaction[],
  options: DustingOptions = {}
): DustingFeatures {
  if (!Array.isArray(transactions)) {
    throw new ValidationError("transactions must be an array");
  }

  const accountId = resolveAccountId(options.accountId);
  const dustThreshold = resolveDustThreshold(options.dustThreshold);

  let outboundPaymentCount = 0;
  let dustPaymentCount = 0;
  let dustTotalVolume = 0;
  const recipients = new Set<string>();
  const assets = new Set<string>();

  for (const transaction of transactions) {
    if (!transaction || typeof transaction !== "object") {
      continue;
    }
    if (!isOutboundPayment(transaction, accountId)) {
      continue;
    }
    outboundPaymentCount += 1;

    const amount =
      typeof transaction.amount === "number" && Number.isFinite(transaction.amount)
        ? transaction.amount
        : 0;
    if (amount <= 0 || amount > dustThreshold) {
      continue;
    }

    const to = transaction.to;
    if (typeof to !== "string" || to.trim().length === 0 || to === accountId) {
      continue;
    }

    dustPaymentCount += 1;
    dustTotalVolume += amount;
    recipients.add(to);
    assets.add(assetId(transaction));
  }

  const dustRecipientCount = recipients.size;
  const dustAverageAmount = dustPaymentCount > 0 ? dustTotalVolume / dustPaymentCount : 0;

  // Severity scales with how many recipients received dust and how much
  // of outbound payment activity is dust-like. Kept bounded and deterministic.
  const recipientFactor = clamp01(dustRecipientCount / 10);
  const paymentFactor = clamp01(dustPaymentCount / 20);
  const outboundFactor =
    outboundPaymentCount > 0 ? clamp01(dustPaymentCount / outboundPaymentCount) : 0;
  const dustingScore = clamp01(
    recipientFactor * 0.55 + paymentFactor * 0.25 + outboundFactor * 0.2
  );

  return {
    dustPaymentCount,
    dustRecipientCount,
    dustTotalVolume,
    dustAverageAmount,
    dustAssetDiversity: assets.size,
    outboundPaymentCount,
    dustingScore,
    dustThreshold,
  };
}

/**
 * Flattens dusting features into the registry's uniform map (#24).
 */
export function dustingFeaturesToFeatureMap(features: DustingFeatures): FeatureMap {
  return {
    dustPaymentCount: features.dustPaymentCount,
    dustRecipientCount: features.dustRecipientCount,
    dustTotalVolume: features.dustTotalVolume,
    dustAverageAmount: features.dustAverageAmount,
    dustAssetDiversity: features.dustAssetDiversity,
    dustOutboundPaymentCount: features.outboundPaymentCount,
    dustingScore: features.dustingScore,
    dustThreshold: features.dustThreshold,
  };
}

/** Options for {@link createDustingFeatureProvider}. */
export interface DustingProviderOptions extends DustingOptions {}

/**
 * Creates a registry-ready dusting provider (#24, #28).
 *
 * The scored account comes from `context.accountId` or `context.account.id`.
 */
export function createDustingFeatureProvider(
  options: DustingProviderOptions = {}
): FeatureProvider {
  return {
    name: "dusting",
    compute(context: FeatureContext): FeatureMap {
      const accountId =
        context.accountId ?? context.account?.id ?? options.accountId;
      return dustingFeaturesToFeatureMap(
        extractDustingFeatures(context.transactions, {
          accountId,
          dustThreshold: options.dustThreshold,
        })
      );
    },
  };
}
