# Roadmap

`fraud-detection-sdk` is currently in **alpha**. The public API may change
between releases. This roadmap outlines the planned path to a stable 1.0
release and beyond.

---

## Current phase: Foundation (alpha)

The SDK provides the core scoring pipeline: data ingestion from Horizon or
transaction-analytics-api, feature extraction, rule-based detection, signal
aggregation, and risk-level classification.

### Recently completed
- Core `FraudDetector` class with `scoreAccount`
- Shared error taxonomy (`src/errors.ts`)
- Horizon REST client with retry and pagination (`src/clients/horizon.ts`)
- Retry wrapper with exponential backoff (`src/clients/http.ts`)
- transaction-analytics-api adapter with `DataSource` interface
  (`src/clients/transactionAnalytics.ts`)
- Configuration validation (`src/config.ts`)
- Structured logging with redaction (`src/logging.ts`)
- Public type definitions (`src/types.ts`)

---

## Phase 1: Core detection (0.1.x)

Rule-based and statistical detectors for Stellar-specific fraud patterns.

- [ ] Rule-based detectors for Stellar-specific patterns
  - Path payment layering detection
  - Trustline abuse and asset spam detection
  - Fresh account detection (account created < 24h ago)
  - Rapid fan-in / fan-out detection
- [ ] Baseline and statistical anomaly detection
  - Per-account behavioral baselines
  - Per-asset behavioral baselines
  - Transaction count and velocity anomaly detection
- [ ] Configurable risk thresholds per deployment

---

## Phase 2: Reliability (0.2.x)

Hardening the SDK for production use: testing, observability, and resilience.

- [ ] Deterministic snapshot tests for score reproducibility
- [ ] Property-based tests for score bounds (0–1)
- [ ] Integration tests against testnet Horizon
- [ ] Coverage thresholds and reporting
- [ ] CI test workflow (GitHub Actions)
- [ ] Horizon response test fixtures
- [ ] ESLint + Prettier configuration
- [ ] Canonical `npm run check` pipeline (lint + typecheck + test)
- [ ] Pre-commit hooks (husky / lint-staged)

---

## Phase 3: Ecosystem adoption (0.3.x–1.0)

Integration with the broader Stellar ecosystem and production readiness.

- [ ] Graph-based fund-flow features
  - Counterparty clustering
  - Fund-flow tracing across multiple hops
- [ ] Trained ML model with published evaluation
- [ ] Soroban contract interaction signals
- [ ] SDP-compatible disbursement file export
- [ ] Integration with `funding-optimizer` for disbursement risk checks
- [ ] Dashboard for funders
- [ ] Stable 1.0 release with semantic versioning

---

## Release policy

- Pre-1.0 releases may introduce breaking changes in minor versions.
- After 1.0, we follow [semantic versioning](https://semver.org).
- Security fixes are applied to `main` and included in the next published
  package (see [SECURITY.md](SECURITY.md)).

---

## Feedback

This roadmap is a living document. Open an issue or start a discussion to
suggest changes or prioritize features.
