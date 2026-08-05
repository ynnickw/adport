# Contributing to adport

Thanks for your interest! adport is early — the fastest way to help is to open an issue describing what you want to build or fix before sending a PR.

## Developer Certificate of Origin (DCO)

All commits must be signed off, certifying the [Developer Certificate of Origin](https://developercertificate.org/):

```sh
git commit -s -m "feat: ..."
```

This adds a `Signed-off-by: Your Name <you@example.com>` trailer. PRs with unsigned commits can't be merged.

## Development setup

Requirements: Node ≥ 20.19, pnpm ≥ 9.

```sh
pnpm install
pnpm build       # turbo builds all packages
pnpm test        # vitest across packages
pnpm typecheck
```

## Project principles

- **One tool-definition layer.** Tools are defined once in `@adport/core`; the MCP server and CLI are thin adapters. Never define a tool twice.
- **All writes go through the policy engine.** No provider may expose a mutation that bypasses the validate→apply pending-operation flow.
- **Lean tool descriptions.** Heavy reference material belongs in on-demand resources/schema tools, not in every tool description.
- **No telemetry.** The CLI and MCP server send nothing anywhere except the ad platforms you connect.
