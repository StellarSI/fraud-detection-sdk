# Contributing to fraud-detection-sdk

Thanks for your interest in improving the SDK. This guide covers local setup,
the checks we run, and the conventions we follow.

## Getting started

### Requirements

- Node.js 20 or newer
- npm (bundled with Node.js)

### Local setup

```bash
# Clone the repository
git clone https://github.com/StellarSI/fraud-detection-sdk.git
cd fraud-detection-sdk

# Install dependencies
npm install

# Run type checking
npm run typecheck

# Run the test suite
npm test

# Build the package
npm run build

# Run all checks (typecheck + tests)
npm run check
```

`npm run check` runs the type check. `npm run lint` runs the linter. `npm test`
runs the Vitest test suite. `npm run build` compiles TypeScript to `dist/`.

### Project layout

```
src/
  FraudDetector.ts        # Scoring entry point (scoreAccount, watch, getConfig)
  config.ts               # Configuration validation and resolution
  config.test.ts          # Config tests
  errors.ts               # Shared error taxonomy
  errors.test.ts          # Error taxonomy tests
  FraudDetector.test.ts   # Detector tests
  index.ts                # Public API entry point
  logging.ts              # Structured logging
  logging.test.ts         # Logging tests
  network.ts              # Stellar network presets
  network.test.ts         # Network preset tests
  types.ts                # Public type definitions
  clients/
    errorMapping.ts       # Shared HTTP status → SDK error mapping
    errorMapping.test.ts  # Error mapping tests
    horizon.ts            # Horizon REST client (retry, pagination)
    horizon.test.ts       # Horizon client tests
    http.ts               # Retry wrapper (withRetry, fetchWithRetry)
    http.test.ts          # Retry wrapper tests
    transactionAnalytics.ts # transaction-analytics-api adapter (DataSource)
    transactionAnalytics.test.ts  # Adapter tests
  features/
    types.ts              # FeatureProvider / FeatureMap contracts
    velocity.ts           # Velocity feature extraction
    velocity.test.ts      # Velocity tests
    graph.ts              # Bounded counterparty graph and features
    graph.test.ts         # Graph tests
    index.ts              # Feature family exports
  scoring/
    aggregate.ts          # Signal aggregation
    aggregate.test.ts     # Aggregation tests
    levels.ts             # Risk-level classification
    levels.test.ts        # Levels tests
    normalize.ts          # Score normalization
    normalize.test.ts     # Normalize tests
```

Tests live next to the code they cover as `*.test.ts` files. Add or update a
test with every behavior change.

## Making changes

1. **Open an issue first** for larger changes so the approach can be agreed
   before implementation. For small bug fixes, you can open a PR directly.
2. **Create a branch from `main`**:

   ```bash
   git checkout -b feature/short-description main
   ```

3. **Keep commits focused** and use clear messages. Reference the issue in the
   body, for example `Closes #42`.
4. **Run the checks** above before opening a pull request:

   ```bash
   npm run typecheck
   npm run lint
   npm test
   npm run build
   ```

5. **Describe the behavior change**, the tests you added, and any trade-offs in
   the pull request.

## Issue reporting expectations

- Search existing issues before creating a new one.
- Use the [bug report template](.github/ISSUE_TEMPLATE/bug_report.md) for bugs.
- Use the [feature request template](.github/ISSUE_TEMPLATE/feature_request.md)
  for new features.
- Include enough detail to reproduce: SDK version, Node version, steps to
  reproduce, expected vs. actual behavior.
- For security vulnerabilities, do **not** open a public issue. See the
  [Security reporting](#security-reporting) section below.

## Pull request workflow and standards

1. Fork the repository and create your branch from `main`.
2. Implement your change with tests.
3. Run `npm run check`, `npm run lint`, and `npm test`—all must pass.
4. Ensure TypeScript compiles cleanly (`tsc --noEmit`).
5. Open a pull request against `main`.
6. Use the [PR template](.github/PULL_REQUEST_TEMPLATE.md).
7. Reference the issue your PR addresses, e.g. `Closes #42`.
8. Respond to maintainer review comments in a timely manner.

### PR checklist

- [ ] Tests pass (`npm test`)
- [ ] Type check passes (`npm run typecheck`)
- [ ] Lint passes (`npm run lint`)
- [ ] Build passes (`npm run build`)
- [ ] New behavior has test coverage
- [ ] Documentation is updated (README, docs, etc.)
- [ ] PR description references the issue

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

## TypeScript code quality expectations

- Target **TypeScript 5.5+** with `strict: true` enabled.
- All public APIs must have explicit type annotations.
- Avoid `any`; use `unknown` and type guards instead.
- Prefer interfaces over type aliases for public object shapes.
- Use `readonly` and immutable data structures where possible.
- All exported functions and classes need JSDoc comments.
- Error types must extend `FraudDetectorError` from `src/errors.ts`.
- Tests must run offline (no live network calls); use `vitest` mocks/fixtures.

## Security

Do not open a public issue for a vulnerability. Follow
[SECURITY.md](SECURITY.md) to report it privately.

## License

By contributing, you agree that your contributions are licensed under the
[MIT License](LICENSE).
