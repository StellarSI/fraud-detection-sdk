# Stellar Fraud Detection SDK — Runnable Examples

This directory provides runnable, end-to-end demonstrations verifying the SDK's core features against the Stellar network.

## Examples Directory

1. **`basic-scoring.ts`**
   - Connects to the Stellar Testnet Horizon server.
   - Evaluates a target Stellar public key account.
   - Outputs composite anomaly scores, threat level classification, and detected risk signals.

2. **`streaming-watcher.ts`**
   - Sets up continuous asset stream filters (e.g. USDC).
   - Demonstrates risk triage logic and compliance pipeline dispatching for high-risk accounts.

---

## How to Run

Ensure dependencies are installed from repository root:
```bash
npm install
```

Run with `npx tsx` or `npx ts-node`:

```bash
# Run basic account scoring demo
npx tsx examples/basic-scoring.ts

# Run streaming asset watcher demo
npx tsx examples/streaming-watcher.ts
```
