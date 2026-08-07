# adport

> Open-source multi-platform ads management for AI agents. Connect your Google Ads, Meta Ads, and TikTok Ads accounts once, then monitor and manage them by talking to any agent — through an MCP server and CLI, with real read *and* write access behind auditable safety rails.

**Status: v0.1 (unpublished).** Five providers integrated, every one verified against mocked API responses whose shapes come from the current official docs; Google additionally live-verified. See [start-spec.md](./start-spec.md) for the plan and [CHANGELOG.md](./CHANGELOG.md) for what's in.

| Provider | API | Reads | Writes | Dry run | Sandbox |
| --- | --- | --- | --- | --- | --- |
| Google Ads | REST v24 | GAQL + normalized report | campaigns, ad groups, keywords, RSAs, budgets, bidding | server-side `validate_only` | test accounts |
| Meta Ads | Graph v26.0 | Insights + normalized report | campaigns, ad sets, budgets, status | server-side `execution_options` | dev-mode accounts |
| TikTok Ads | Business API v1.3 | sync reporting + normalized report | campaigns, budgets, status | client-side diff | ✅ sandbox env |
| Apple Ads | Campaign Mgmt v5* | campaign reports + normalized report | campaigns, budgets, status | client-side diff | — |
| Microsoft Advertising | REST v13 | async CSV reporting + normalized report | campaigns, budgets, status | client-side diff | ✅ universal token |

*Apple's v5 sunsets Jan 2027; the provider has a version-isolated client ready for the new Ads Platform API.

## Why

- **Agent-first.** The product surface is an MCP server and a CLI — connect it to Claude, Cursor, or any agent and talk to your ads.
- **Genuinely open.** The entire multi-platform core is Apache-2.0 and self-hostable with your own API credentials.
- **Writes with structural safety.** Every mutation is two-step: a dry-run returns a preview and a `pending_operation_id`; applying requires that ID. Created entities are paused by default, budget changes are capped by policy, and everything lands in an audit log.
- **Connection as a product.** `adport connect <provider>` walks you through each platform's credential maze (and yes — since Google's Explorer tier, a fresh Google Ads developer token works the same day).

## The recommendation harness

adport goes beyond consolidation: `adport audit run` evaluates pluggable **rule packs** (OPA-style — rules decoupled from provider code) over normalized cross-platform campaign data and persists structured findings: zero-conversion spend, low CTR, CPA outliers, below-break-even ROAS. Findings that carry a proposed fix can be applied with `adport recommendations apply <id>` — which routes through the same two-step validate→apply gate as every other write. Findings wait durably for your decision (open/dismissed/applied) across restarts. There is deliberately **no "account score"**: interaction-based scores are gameable and distrusted; adport reports concrete findings instead.

## Repo layout

```
packages/
  core/       @adport/core                — provider interface, tool registry, policy engine,
              audit harness (rule packs), credential store
  google/     @adport/provider-google     — Google Ads (REST, no heavy SDK)
  meta/       @adport/provider-meta       — Meta Marketing API
  tiktok/     @adport/provider-tiktok     — TikTok Business API (+ sandbox)
  apple/      @adport/provider-apple      — Apple Ads (ES256-JWT OAuth)
  microsoft/  @adport/provider-microsoft  — Microsoft Advertising REST (+ sandbox)
  mcp/        @adport/mcp                 — MCP server (stdio) over the shared tool registry
  cli/        adport                      — CLI over the same tool registry
```

## Development

```sh
pnpm install
pnpm build
pnpm test
```

Try it against the built-in mock provider (no credentials needed):

```sh
node packages/cli/dist/index.js tools list
node packages/cli/dist/index.js accounts
node packages/cli/dist/index.js mcp   # stdio MCP server
```

## Connect Google Ads

```sh
node packages/cli/dist/index.js connect google
```

The wizard walks you through the four credentials (MCC + developer token + OAuth desktop client + refresh token via a local OAuth flow) and imports an existing `~/google-ads.yaml` automatically if you have one. Since Google's Explorer access tier, a fresh developer token works on production accounts the same day — no approval wait to get started.

Then verify and use it:

```sh
node packages/cli/dist/index.js doctor
node packages/cli/dist/index.js report --provider google --metrics spend,clicks,roas --range last_7_days
```

## Connect the other providers

```sh
node packages/cli/dist/index.js connect tiktok      # sandbox same-day; production after TikTok's app review
node packages/cli/dist/index.js connect apple       # self-serve: local EC keypair + public-key upload, no approval
node packages/cli/dist/index.js connect microsoft   # easiest: self-serve token, PKCE sign-in, sandbox universal token
```

## Connect Meta Ads

```sh
node packages/cli/dist/index.js connect meta
```

No App Review is needed for your own ad accounts: create a dev-mode Business app, generate a **system-user token** (never expires — the wizard explains where), paste it, done (~20-30 min the first time). User tokens work too; adport warns you about their ~60-day expiry. Budgets use Meta's native minor units (cents), and every write supports Meta's server-side `execution_options=["validate_only"]` dry run.

## Use from an MCP client (Claude Code, Claude Desktop, Cursor, ...)

```json
{
  "mcpServers": {
    "adport": {
      "command": "node",
      "args": ["/path/to/adport/packages/mcp/dist/bin.js"]
    }
  }
}
```

Every mutation is two-step by contract: the first call returns a dry-run preview plus a `pending_operation_id`; only a second call with that id applies the change. Campaign creation is paused-by-default, budget jumps beyond the policy cap are rejected, and everything is written to a local audit log (`adport audit`). Tune the rails in `~/.config/adport/policy.yaml` (see `adport policy`).

## License

[Apache-2.0](./LICENSE). Contributions require a DCO sign-off (`git commit -s`) — see [CONTRIBUTING.md](./CONTRIBUTING.md).
