# Security Policy

## Supported Versions

`fraud-detection-sdk` is pre-1.0. Security fixes are applied to `main` and
included in the next published package.

| Version | Supported |
| --- | --- |
| `main` (0.0.x) | :white_check_mark: |
| Older releases and forks | :x: |

## Reporting a Vulnerability

**Please do not open a public issue, pull request, or discussion for a security
problem.**

Report it privately through GitHub's private vulnerability reporting:

1. Open
   <https://github.com/StellarSI/fraud-detection-sdk/security/advisories/new>.
2. Include the affected version or commit, impact, and reproduction steps.
3. If you have a suggested fix, describe it in the report rather than opening a
   public PR first.

If GitHub Security Advisories are unavailable to you, contact the maintainers
through the StellarSI organization (<https://github.com/StellarSI>) and ask for
a private channel. Do not include exploit details in a public message.

## What to Expect

- **Acknowledgement** within 2 business days.
- **Triage** within 7 days, including a severity assessment and remediation
  plan.
- **Coordinated disclosure**: we will agree on a disclosure date with you and
  will not publish details until a fix is available.
- **Credit**: reporters who want credit will be named in the advisory.

## Scope

In scope:

- Scoring logic, normalization, and risk-level calculation
- Horizon and network integration helpers
- Configuration handling and public types
- Packaging and build output

Out of scope: vulnerabilities in Stellar Horizon or Stellar RPC, and
social-engineering attacks. Report those to the relevant vendor.

## Safe Harbor

We will not pursue legal action against researchers who act in good faith,
avoid privacy violations and service disruption, and give us reasonable time to
fix an issue before public disclosure.
