# fraud-detection-sdk

> **AI models for anomaly detection in Stellar transactions.**  
> Score Stellar accounts and transactions for anomalous or suspicious behavior with explainable, auditable risk signals.

[![Network](https://img.shields.io/badge/network-Stellar-black)](https://stellar.org)
[![Status](https://img.shields.io/badge/status-alpha-orange)](ROADMAP.md)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![CI](https://github.com/StellarSI/fraud-detection-sdk/actions/workflows/ci.yml/badge.svg)](https://github.com/StellarSI/fraud-detection-sdk/actions/workflows/ci.yml)

Part of the **StellarSI** toolkit, alongside [`transaction-analytics-api`](https://github.com/StellarSI/transaction-analytics-api) and [`funding-optimizer`](https://github.com/StellarSI/funding-optimizer).

---

## Why this project exists

Generic fraud models miss patterns that are unique to the Stellar network. `fraud-detection-sdk` is built around Stellar-specific risks:

- **Path payments** used to obscure asset origin or layer value through multiple hops
- **Trustline abuse**: mass trustline creation, asset spam, and "dusting" of accounts
- **Account lifecycle tricks**: fresh accounts funded via `create_account`, rapid merges, and throwaway accounts
- **Claimable balance abuse** and unsolicited claim spam
- **Memo patterns**: reused memo IDs and anchor deposit/withdrawal anomalies
- **Multi-signature and clawback-enabled assets** with unusual authorization activity
- **Rapid fan-in / fan-out** across many accounts within a few ledgers

The SDK scores Stellar accounts and transactions on a 0–1 risk scale, returning explainable signals so human reviewers can act on them—not replace them.

---

## Current status: Alpha

This project is in **alpha**. The public API may change between releases. See [ROADMAP.md](ROADMAP.md) for the planned path to a stable 1.0.

---

## Installation

```bash
npm install @stellarsi/fraud-detection-sdk
```

> Package names are placeholders until the first published release. Adjust to your published names.

Node.js 20+ is required.

---

## Quick start

```ts
import { FraudDetector } from "@stellarsi/fraud-detection-sdk";

const detector = new FraudDetector({
  network: "testnet",
  horizonUrl: "https://horizon-testnet.stellar.org",
});

const result = await detector.scoreAccount("GABCDEFGHIJKLMNOPQRSTUVWXYZABCDEFGHIJKLMNOPQRSTUVWXYZABCDEF");

console.log(result.score);    // 0.87
console.log(result.level);    // "high"
console.log(result.signals);  // [{ id: "rapid-fan-out", weight: 0.41 }, ...]
```

### Streaming

```ts
detector.watch({ assets: ["USDC:GA5Z..."] }, (alert) => {
  if (alert.level !== "low") {
    // send to your review queue, hold a payout, notify compliance
  }
});
```

> `watch()` is planned and not yet implemented. See [ROADMAP.md](ROADMAP.md).

---

## Risk levels and scoring

Scores are bounded to 0–1 and mapped to risk bands:

| Level | Score | Suggested action |
| :--- | :--- | :--- |
| `low` | < 0.40 | Proceed normally |
| `medium` | 0.40–0.70 | Log and monitor |
| `high` | > 0.70 | Hold and require manual review |

Thresholds are configurable. Tune them against your own data and tolerance for false positives.

Each score includes the signals that drove it, with weights and human-readable explanations. Scores are **signals, not verdicts**—keep a human in the loop.

---

## Architecture

```
Horizon / transaction-analytics-api
              │
              ▼
      Feature extraction
   (velocity, graph, asset, memo)
              │
     ┌────────┼────────┐
     ▼        ▼        ▼
   Rules  Statistical   ML
            models    models
     └────────┼────────┘
              │
      Score + explanation (signals)
```

The SDK consists of these core modules:

| Module | Responsibility |
| :--- | :--- |
| `FraudDetector` | Main entry point: scoring, orchestration, logging |
| `config` | Configuration validation and resolution |
| `errors` | Shared error taxonomy for the SDK |
| `clients/horizon` | Horizon REST client with retry and pagination |
| `clients/http` | Retry wrapper with exponential backoff |
| `clients/transactionAnalytics` | transaction-analytics-api adapter (DataSource) |
| `clients/errorMapping` | Shared HTTP status → SDK error mapping |
| `features/velocity` | Velocity features over configurable time windows |
| `features/graph` | Bounded counterparty graph, degree, clustering, reachability |
| `scoring/normalize` | Score normalization and clipping |
| `scoring/levels` | Risk-level classification and thresholds |
| `scoring/aggregate` | Signal aggregation and scoring |
| `logging` | Structured logging with redaction |
| `network` | Stellar network presets (testnet/mainnet) |
| `types` | Public type definitions |

See [docs/architecture.md](docs/architecture.md) for the full architectural overview.

### Feature extraction

Feature families expose pure, registry-ready providers (`src/features/types.ts`):

- `extractVelocityFeatures` / `createVelocityFeatureProvider` — windowed
  transaction counts, transactions per ledger, and unique counterparties.
- `buildCounterpartyGraph` / `extractGraphFeatures` /
  `createGraphFeatureProvider` — a bounded directed counterparty graph with
  degree, local clustering, and reachability features.

Providers return a flat `FeatureMap` so detectors, models, and the future
registry consume one representation. Velocity window sizes and graph node/edge
bounds are configurable so large histories stay within memory.

---

## Responsible use

A score is a **signal, not a verdict**. Keep a human in the loop for decisions that affect users:

- Expect false positives, especially for new accounts and legitimate high-volume actors such as anchors and market makers.
- Do not use scores as the sole basis for blocking people from essential services.
- Evaluate and monitor models regularly for drift and bias.
- This SDK **recommends**; it never signs or submits payouts. Payouts remain under your control via the Stellar Disbursement Platform (SDP) or your own signing flow.

---

## Contributing

Issues and PRs are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md) for the full guide, including:

- Local setup and running checks
- Issue reporting expectations
- Pull request workflow and standards
- Security reporting guidance
- TypeScript code quality expectations

For security-sensitive reports, please contact the maintainers privately rather than opening a public issue. See [SECURITY.md](SECURITY.md).

---

## Roadmap

See [ROADMAP.md](ROADMAP.md) for the planned path from alpha to a stable 1.0, including constraint-based allocation, delivery-time forecasting, scenario comparison, SDP-compatible export, and dashboard integration.

---

## Architecture documentation

See [docs/architecture.md](docs/architecture.md) for the core module structure, extension points, and design goals.

---

## Related projects

- [`transaction-analytics-api`](https://github.com/StellarSI/transaction-analytics-api): real-time flow data
- [`funding-optimizer`](https://github.com/StellarSI/funding-optimizer): grant allocation analytics
- [Stellar Developers](https://developers.stellar.org) · [Stellar Expert](https://stellar.expert)

---

## License

MIT. See [LICENSE](LICENSE).

---

## Support

- **Security**: Report via GitHub Security Advisories (see [SECURITY.md](SECURITY.md))
- **Questions**: Open a discussion or issue on GitHub
- **Bugs**: Use the [bug report template](.github/ISSUE_TEMPLATE/bug_report.md)
- **Features**: Use the [feature request template](.github/ISSUE_TEMPLATE/feature_request.md)
