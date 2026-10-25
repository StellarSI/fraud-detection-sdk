# Contributing to fraud-detection-sdk

Thanks for your interest in improving the SDK. This guide covers local setup,
the checks we run, and the conventions we follow.

## Getting started

Requirements: Node.js 20 or newer.

```bash
npm install
npm run typecheck
npm test
npm run build
```

`npm run check` is an alias for the type check. Linting and formatting are not
configured yet (tracked in
[#94](https://github.com/StellarSI/fraud-detection-sdk/issues/94) and
[#95](https://github.com/StellarSI/fraud-detection-sdk/issues/95)); match the
style of the surrounding code in the meantime.

## Project layout

- `src/FraudDetector.ts` — scoring entry point
- `src/scoring/normalize.ts` — feature normalization
- `src/scoring/levels.ts` — risk-level thresholds
- `src/network.ts` — Horizon/network helpers
- `src/config.ts` — configuration
- `src/types.ts` — shared public types

Tests live next to the code they cover as `*.test.ts` files. Add or update a
test with every behavior change.

## Making changes

1. Open an issue first for larger changes so the approach can be agreed before
   implementation.
2. Create a branch from `main`:

   ```bash
   git checkout -b feature/short-description main
   ```

3. Keep commits focused and use clear messages. Reference the issue in the
   body, for example `Closes #42`.
4. Run the checks above before opening a pull request.
5. Describe the behavior change, the tests you added, and any trade-offs in the
   pull request.

## Language guideline

This SDK scores behavior, not people. User-facing strings, docs, and test
fixtures should be behavior-based and non-stigmatizing:

- Prefer wording such as "unusual fan-out", "high-risk pattern", or "flagged
  transaction".
- Avoid labeling an account or person as a "fraudster", "criminal", "guilty",
  or "bad actor".
- Frame a score as a signal that supports a human decision, never as a verdict.
- Keep explanations specific to the observed behavior instead of the identity
  of the account holder.

See "Responsible use" in the [README](README.md) for the product-level policy.

## Security

Do not open a public issue for a vulnerability. Follow
[SECURITY.md](SECURITY.md) to report it privately.

## License

By contributing, you agree that your contributions are licensed under the
[MIT License](LICENSE).
