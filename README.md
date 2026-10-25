# fraud-detection-sdk

> AI models for anomaly detection in Stellar transactions.

![Network](https://img.shields.io/badge/network-Stellar-black)
![Status](https://img.shields.io/badge/status-in%20development-orange)
![License](https://img.shields.io/badge/license-MIT-blue)

`fraud-detection-sdk` scores Stellar accounts and transactions for anomalous or suspicious behavior. Drop it into a wallet, anchor, exchange or disbursement pipeline to flag risk early, with explanations a human reviewer can act on.

Part of the **StellarSI** toolkit, alongside [`transaction-analytics-api`](https://github.com/StellarSI/transaction-analytics-api) and [`funding-optimizer`](https://github.com/StellarSI/funding-optimizer).

## Why Stellar-specific

Generic fraud models miss patterns unique to Stellar. This SDK is built around them:

- **Path payments** used to obscure asset origin or layer value through multiple hops
- **Trustline abuse**: mass trustline creation, asset spam, and "dusting" of accounts
- **Account lifecycle tricks**: fresh accounts funded via `create_account`, rapid merges, and throwaway accounts
- **Claimable balance abuse** and unsolicited claim spam
- **Memo patterns**: reused memo IDs and anchor deposit/withdrawal anomalies
- **Multi-signature and clawback-enabled assets** with unusual authorization activity
- **Rapid fan-in / fan-out** across many accounts within a few ledgers

## Features

- **Anomaly scoring** for accounts and transactions (0–1 risk score)
- **Explainable output**: each score includes the signals that drove it
- **Behavioral baselines** per account and per asset
- **Graph features**: counterparty clustering and fund-flow tracing
- **Streaming and batch modes**: score live ledgers or historical windows
- **Pluggable models**: rules, statistical detectors and ML models, usable together
- **Works offline**: bring your own Horizon endpoint or `transaction-analytics-api`

## Installation

```bash
npm install @stellarsi/fraud-detection-sdk
# or
pip install stellarsi-fraud-detection
```

> Package names are placeholders until the first release. Adjust to your published names.

## Quick start (planned API)

```ts
import { FraudDetector } from "@stellarsi/fraud-detection-sdk";

const detector = new FraudDetector({
  network: "testnet",
  horizonUrl: "https://horizon-testnet.stellar.org",
});

const result = await detector.scoreAccount("GABC...XYZ");

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

## Risk levels

| Level | Score | Suggested action |
| --- | --- | --- |
| `low` | < 0.40 | Proceed normally |
| `medium` | 0.40–0.70 | Log and monitor |
| `high` | > 0.70 | Hold and require manual review |

Thresholds are configurable. Tune them against your own data and tolerance for false positives.

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
              ▼
   Score + explanation (signals)
```

## Responsible use

- A score is a **signal, not a verdict**. Keep a human in the loop for decisions that affect users.
- Expect false positives, especially for new accounts and legitimate high-volume actors such as anchors and market makers.
- Do not use scores as the sole basis for blocking people from essential services.
- Evaluate and monitor models regularly for drift and bias.

## Roadmap

- [ ] Rule-based detectors for Stellar-specific patterns
- [ ] Baseline and statistical anomaly detection
- [ ] Graph-based fund-flow features
- [ ] Trained ML model with published evaluation
- [ ] Soroban contract interaction signals
- [ ] Integration with `funding-optimizer` for disbursement risk checks

## Contributing

Issues and PRs are welcome. For security-sensitive reports, please contact the maintainers privately rather than opening a public issue. See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).

## Related projects

- [`transaction-analytics-api`](https://github.com/StellarSI/transaction-analytics-api): real-time flow data
- [`funding-optimizer`](https://github.com/StellarSI/funding-optimizer): grant allocation analytics
- [Stellar Developers](https://developers.stellar.org) · [Stellar Expert](https://stellar.expert)

## License

MIT. See [LICENSE](LICENSE).
