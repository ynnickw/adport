# Contributing to Adport

Contributions are welcome: documentation fixes, reproducible bug reports, provider contract tests, and focused improvements. For a new provider or a substantial design change, open an issue first so we can agree on the scope. Small fixes can go straight to a pull request.

## Get started

Use Node.js 22.13 or newer and the exact pnpm version in the root `packageManager` field. CI runs Node.js 22 and 24.

```sh
git clone https://github.com/ynnickw/adport.git
cd adport
corepack enable
pnpm install --frozen-lockfile
git switch -c fix/describe-the-change
pnpm build
```

No advertising credentials are needed. For safe CLI experiments, use synthetic data with `node packages/cli/dist/index.js --demo accounts`. Keep local `.env` files, account data, provider credentials, and generated output out of commits. Cloud development is optional; follow the [Cloud setup guide](docs/cloud/local-development.md) if your change needs it.

## Make a focused change

- **Keep one tool-definition layer.** Register typed tools once; CLI, MCP, and Cloud consume the shared registry.
- **Route every provider mutation through `guardedWriteTool` and the policy engine.** Preserve preview/apply binding, expiry, protected accounts, budget caps in micros, paused creation, reported coercions, and the audit trail.
- **Test the wire contract.** Provider tests mock `fetch` and assert request methods, headers, bodies, pagination, update masks, currency conversions, and error envelopes against the official API documentation. Record the source and verification date when changing a contract.
- **Distinguish fixtures from live evidence.** A mocked response does not prove provider approval or successful live execution. Default tests must not contact advertising APIs. Use explicit operator authorization for real-account writes.
- **Keep tool descriptions lean.** Put detailed reference material in on-demand schemas, resources, or documentation.
- **Preserve privacy.** The local CLI and MCP server contain no telemetry. Never add logging of tokens, request credentials, or private account data.

Match the surrounding TypeScript and ESM style. Avoid unrelated formatting or dependency changes. Update user documentation when behavior changes; explain any migration or compatibility impact in the PR.

## Validate

```sh
pnpm check       # repository hygiene, docs, manifests, website, tooling tests
pnpm build
pnpm test
pnpm typecheck
pnpm check:packages  # pack every public package and smoke-test an isolated install
```

For a targeted iteration, use `pnpm --filter @adport/provider-google test` (or the relevant workspace). The full checks above run in CI; package installation smoke tests run once on Node.js 24. Database and live-server suites are opt-in and may be skipped by the default test run. State those limits in your PR.

For workflow changes, also run `actionlint` if installed. See [docs/maintainers/releasing.md](docs/maintainers/releasing.md) for release changes.

## Sign off your commits

All human-authored commits require a [Developer Certificate of Origin](https://developercertificate.org/) sign-off. Use your own name and email:

```sh
git commit -s -m "fix: describe the behavior corrected"
```

This adds `Signed-off-by: Your Name <you@example.com>`. It is a contribution certification, not a cryptographic signature. CI checks that each human commit in a pull request contains its author's sign-off; dependency automation commits are exempt.

If you missed a sign-off on your latest unpublished commit, run `git commit --amend --no-edit -s`. Coordinate before rewriting a branch that someone else is using.

## Open a pull request

Describe the problem, resulting behavior, and checks you ran. Link the relevant issue, include screenshots for visual changes, and call out skipped integration tests or remaining provider verification. Keep credentials and account identifiers out of examples and screenshots.

Maintainers review changes through pull requests. Releases use reviewed version changes and tags, with npm packages published only after validation. See the [release guide](docs/maintainers/releasing.md).
