/**
 * Public types for @stellarsi/fraud-detection-sdk.
 *
 * Shapes follow the quick-start output (README.md), the feature list,
 * and the risk-level table.
 */

/** Risk bands from the README risk-level table. */
export type RiskLevel = "low" | "medium" | "high";

/** A single explanatory signal that contributed to a score. */
export interface Signal {
  /** Machine-readable signal id, e.g. "rapid-fan-out". */
  id: string;
  /** Relative contribution of this signal to the overall score. */
  weight: number;
  /** Optional human-readable explanation for reviewers. */
  detail?: string;
}

/** Result of scoring an account or transaction. Matches the quick-start output. */
export interface ScoreResult {
  /** Risk score bounded to the 0-1 range. */
  score: number;
  /** Coarse risk band derived from the score. */
  level: RiskLevel;
  /** Ordered list of signals that drove the score. */
  signals: Signal[];
  /** Optional behavioral baseline the score was computed against. */
  baseline?: string;
}

/**
 * Account-level risk result. Alias of ScoreResult so the API can later
 * distinguish account- from transaction-level scoring without breaking
 * existing consumers.
 */
export type AccountRisk = ScoreResult;

/* eslint-disable @typescript-eslint/no-unused-vars */
// Type-level contract tests: each alias fails to compile if the shapes above drift.
type _Assert<T extends true> = T;
type _ScoreIsNumber = _Assert<ScoreResult["score"] extends number ? true : false>;
type _LevelIsRiskLevel = _Assert<ScoreResult["level"] extends RiskLevel ? true : false>;
type _SignalsAreSignals = _Assert<ScoreResult["signals"] extends Signal[] ? true : false>;
type _AccountRiskIsScoreResult = _Assert<AccountRisk extends ScoreResult ? true : false>;
