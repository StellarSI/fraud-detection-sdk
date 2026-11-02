# Architecture

This document describes the core modules, data flow, extension points, and
design goals of `fraud-detection-sdk`. It is intended for contributors and
integrators who want to understand how the SDK works and how to extend it.

---

## Design goals

1. **Stellar-native.** The SDK is built around patterns unique to Stellar
   (path payments, trustline abuse, memo anomalies, etc.), not generic fraud
   models adapted to blockchain data.
2. **Explainable.** Every score includes the signals that drove it, with
   weights and human-readable explanations.
3. **Pluggable.** Data sources, detectors, and models can be swapped or
   extended without rewriting the scoring pipeline.
4. **Safe by default.** Scores are signals, not verdicts. The SDK never
   signs or submits payouts.
5. **Offline-capable.** All tests run without live network access.

---

## Module overview

```
┌─────────────────────────────────────────────────────────────┐
│                      FraudDetector                          │
│  (scoreAccount, watch, getConfig — public entry point)      │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│              Feature extraction (velocity, graph,          │
│              asset, memo — internal to FraudDetector)       │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│              Detectors (rules, statistical, ML)             │
│              └─ aggregate() → score + level + signals       │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│              Data sources (Horizon, transaction-analytics)  │
└─────────────────────────────────────────────────────────────┘
```

### Core modules

| Module | File | Responsibility |
| :--- | :--- | :--- |
| **FraudDetector** | `src/FraudDetector.ts` | Main entry point. Validates input, fetches account data, extracts features, runs detectors, aggregates signals, returns `ScoreResult`. |
| **Config** | `src/config.ts` | Validates constructor options, resolves defaults (network, horizon URL, thresholds). |
| **Errors** | `src/errors.ts` | Shared error taxonomy: `FraudDetectorError`, `ValidationError`, `NotFoundError`, `RateLimitError`, `UpstreamError`, `NetworkError`. |
| **Types** | `src/types.ts` | Public types: `ScoreResult`, `Signal`, `RiskLevel`, `AccountRisk`. |
| **Logging** | `src/logging.ts` | Structured logging with PII redaction. |
| **Network** | `src/network.ts` | Stellar network presets (testnet/mainnet) and default Horizon URLs. |

### Data source layer

| Module | File | Responsibility |
| :--- | :--- | :--- |
| **Horizon client** | `src/clients/horizon.ts` | Horizon REST client with per-request timeout, bounded retries, and taxonomy-conformant error mapping. Implements `getAccount` and `getTransactions`/`getTransactionsStream`. |
| **HTTP retry** | `src/clients/http.ts` | `withRetry()` and `fetchWithRetry()` — exponential backoff with jitter, Retry-After support, transient-only retry. |
| **Analytics adapter** | `src/clients/transactionAnalytics.ts` | `TransactionAnalyticsClient` implementing `DataSource` against the `transaction-analytics-api` service. Normalizes responses into the same `Account`/`Transaction` shapes as Horizon. |

### Scoring layer

| Module | File | Responsibility |
| :--- | :--- | :--- |
| **Aggregate** | `src/scoring/aggregate.ts` | Combines weighted detector outputs: sum, clip to [0, 1], classify level, emit ordered explanation. |
| **Levels** | `src/scoring/levels.ts` | Risk-level classification (`low`/`medium`/`high`) and threshold validation. |
| **Normalize** | `src/scoring/normalize.ts` | Score normalization, unit-interval clipping, range mapping. |

---

## Data flow

1. **Input**: Caller invokes `detector.scoreAccount(accountId)` with a Stellar account ID (`G...`).
2. **Validation**: Account ID is validated locally before any network I/O.
3. **Fetch**: Account data and transaction history are fetched in parallel from the configured data source (Horizon or transaction-analytics-api).
4. **Feature extraction**: Features are computed from account and transaction data (transaction count, unique counterparties, asset diversity, fan-out ratio, trustline count).
5. **Detection**: Rule-based and statistical detectors produce raw signals with weights.
6. **Aggregation**: Signals are combined into a final score (0–1), risk level, and ordered signal list.
7. **Output**: `ScoreResult` is returned with `score`, `level`, `signals`, and `baseline`.

---

## Extension points

### Custom data source

Implement the `DataSource` interface to use a data source other than Horizon:

```ts
import { DataSource, Account, Transaction, GetTransactionsOptions } from "@stellarsi/fraud-detection-sdk";

class MyDataSource implements DataSource {
  async getAccount(address: string): Promise<Account> {
    // Fetch and normalize account data
  }

  async getTransactions(
    address: string,
    options?: GetTransactionsOptions
  ): Promise<Transaction[]> {
    // Fetch and normalize transaction data
  }
}

const detector = new FraudDetector({
  network: "testnet",
  horizonClient: myDataSource as any,
});
```

### Custom detectors

Detectors are internal to `FraudDetector` in the current release. Future
versions will expose a plugin interface for custom rule, statistical, and ML
detectors.

### Custom logger

Pass a structured logger implementing the `Logger` interface:

```ts
import { FraudDetector, Logger, LogLevel } from "@stellarsi/fraud-detection-sdk";

const myLogger: Logger = {
  child: (context) => myLogger,
  info: (message, context) => console.log(message, context),
  error: (message, context) => console.error(message, context),
  warn: (message, context) => console.warn(message, context),
  debug: (message, context) => console.debug(message, context),
};

const detector = new FraudDetector({
  network: "testnet",
  logger: myLogger,
});
```

---

## Design constraints

- **No payouts.** The SDK recommends allocations and scores; it never signs
  or submits transactions.
- **No live network in tests.** All tests use fixtures and mocks.
- **TypeScript strict mode.** `strict: true` is enforced; all public APIs
  have explicit types.
- **Error taxonomy.** All errors extend `FraudDetectorError` with a stable
  `code` and optional `recoverable` flag.

---

## Version stability

This project is in **alpha**. The public API may change between releases.
See [ROADMAP.md](ROADMAP.md) for the planned path to a stable 1.0.
