---
name: Bug report
about: Create a report to help us improve the SDK
title: "[BUG] "
labels: ["bug"]
assignees: ""
---

## What happened

Describe the bug clearly and concisely.

## What you expected to happen

Describe what you expected to happen.

## How to reproduce

Provide a minimal reproducible example:

```ts
import { FraudDetector } from "@stellarsi/fraud-detection-sdk";

const detector = new FraudDetector({
  network: "testnet",
  horizonUrl: "https://horizon-testnet.stellar.org",
});

detector.scoreAccount("G...").then(console.log).catch(console.error);
```

## SDK version

- Version: e.g. `0.0.1`
- Node.js version: `node -v`
- Operating system: e.g. `macOS 15`, `Ubuntu 22.04`, `Windows 11`

## Additional context

Add any other context, screenshots, or stack traces that might help.

## Security note

If this is a security vulnerability, do **not** file a public issue. Follow
[SECURITY.md](../../SECURITY.md) to report it privately.
