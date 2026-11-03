<div align="center">
  <img src="website/favicon.svg" width="56" height="56" alt="Adport" />
  <h1>Adport</h1>
  <p><strong>Manage your ad accounts from the terminal or any AI agent.</strong><br />11 ad providers. One tool registry. Every write previewed first.</p>
  <p>
    <a href="https://github.com/ynnickw/adport/actions/workflows/ci.yml"><img src="https://github.com/ynnickw/adport/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
    <a href="https://www.npmjs.com/package/adport"><img src="https://img.shields.io/npm/v/adport" alt="npm version" /></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue" alt="Apache 2.0 license" /></a>
  </p>
  <p><a href="https://adport.dev">Website</a> · <a href="docs/README.md">Documentation</a> · <a href="https://github.com/ynnickw/adport/releases">Releases</a> · <a href="CONTRIBUTING.md">Contributing</a></p>
</div>

Adport is an open-source control plane for paid media. Connect your advertising accounts, inspect performance, investigate audit findings, and preview changes through the CLI or a Model Context Protocol (MCP) client. Claude Code and other MCP clients use the same typed tools and policy engine as the terminal.

The local CLI and stdio MCP server run on your machine with your own provider credentials. They require no Adport account and contain no telemetry. [Adport Cloud](https://adport.dev/#waitlist) adds hosted connections and a team dashboard; public access is currently through the waitlist.

## Quick start

Requires **Node.js 22.13 or newer**. CI tests Node.js 22 and 24.

```sh
npm install -g adport
adport --version

# Try synthetic accounts without credentials or network access to ad platforms
adport --demo accounts
adport --demo report --range last_7_days
```

To use a real account, follow the [provider connection guide](docs/providers.md) to create your own provider application or obtain its required credentials, then connect:

```sh
adport connect google
adport doctor
adport accounts --provider google
adport report --provider google --metrics spend,clicks,conversions,roas --range last_7_days
```

The same `adport connect <provider>` flow supports all providers below. With no credentials, account and report calls return `NOT_CONNECTED`. Synthetic data is available only through explicit `--demo` or `ADPORT_DEMO=true` opt-in.

## Connect an AI agent

After installing the CLI and connecting a provider, add the local server to Claude Code:

```sh
claude mcp add adport -- adport mcp
```

For other clients that support stdio MCP, use:

```json
{
  "mcpServers": {
    "adport": {
      "command": "adport",
      "args": ["mcp"]
    }
  }
}
```

Start with a request such as “Report my campaign performance for the last seven days. Keep currencies separate.” For a change, ask “Preview pausing this campaign and show the before and after.”

The [hosted plugin](plugins/adport/README.md) uses Cloud OAuth and a remote endpoint. Its availability and provider permissions are separate from local MCP setup.

## What you can do

- **Read accounts and performance.** Use provider-native queries or normalized reports with explicit currencies and attribution limits.
- **Preview and apply changes.** Inspect campaign, budget, status, and other supported mutations before approving the exact operation.
- **Investigate findings.** Run audit rules for wasted spend, low CTR, CPA outliers, and below-break-even ROAS. Findings carry evidence and an open, dismissed, or applied lifecycle.
- **Use one interface everywhere.** Provider modules, tool schemas, and policy checks are shared across CLI, MCP, and Cloud.

```sh
adport tools list
adport audit run
adport recommendations list
adport policy
adport audit show --limit 50
```

## How write approval works

1. Call a write tool with the proposed arguments. The first call returns a preview, budget deltas, policy coercions, and a short-lived `pending_operation_id`.
2. Review the preview. New campaigns are forced paused, and that coercion is reported.
3. Repeat the call with identical arguments and the pending ID to apply it.

Changed arguments, expired approvals, protected accounts, and budget-cap violations are rejected. Applied provider changes are recorded in an append-only audit trail. Recommendations use this same gate; they cannot bypass it.

Local state lives under `${ADPORT_HOME:-~/.config/adport}`. Credentials are stored in `credentials.json` with mode `0600`; policy is configured in `policy.yaml`. See the [write-safety contract](docs/write-safety.md) for the full behavior, including provider-side validation limits.

## Providers

All 11 providers have local connection commands, normalized reports, and guarded write tools. Coverage varies by provider; implementation and contract tests do not establish approval or successful live execution for every operation.

| Provider | Connection ID | Capabilities and setup |
| --- | --- | --- |
| Google Ads | `google` | [GAQL, campaigns, ad groups, keywords, RSA copy/status, budgets, bidding](docs/providers.md#google-ads) |
| Meta Ads | `meta` | [Insights, ads, creatives/media, targeting, audiences, budgets, status](docs/providers.md#meta-ads) |
| TikTok Ads | `tiktok` | [Reports, campaigns, budgets, status, sandbox support](docs/providers.md#tiktok-ads) |
| Apple Ads | `apple` | [Campaigns, ad groups, keywords, creatives, reports](docs/providers.md#apple-ads) |
| Microsoft Advertising | `microsoft` | [Detailed reports, campaigns, ad groups, keywords/exclusions, RSAs, images/extensions, targeting, budgets, status](docs/providers.md#microsoft-advertising) |
| Reddit Ads | `reddit` | [Campaign children, creative/media, structured posts, targeting, reports](docs/reddit-campaign-setup.md) |
| Snapchat Ads | `snapchat` | [Campaign hierarchy, creative/media, targeting, audiences, measurement](docs/snapchat-campaign-setup.md) |
| Spotify Ads | `spotify` | [Reports, unpublished drafts, campaign status, ad-set delivery](docs/providers/spotify.md) |
| Pinterest Ads | `pinterest` | [Discovery, reports, campaigns, budgets, status](docs/providers/pinterest.md) |
| LinkedIn Ads | `linkedin` | [Campaigns/groups, targeting, bids, text creatives and image library](docs/providers/linkedin.md) |
| X Ads | `x` | [Campaigns, line-item lifecycle, targeting, draft creatives/media and analytics](docs/providers/x.md) |

Provider application approval, account access, and available metrics depend on the platform. The [connection guides](docs/providers.md) record prerequisites and testing limits. Reports preserve currency and attribution differences; see [reporting semantics](docs/reporting-semantics.md) before comparing providers.

## Local or Cloud

| | Local CLI and MCP | Adport Cloud |
| --- | --- | --- |
| Setup | Install `adport`, bring your own provider applications and credentials | Hosted provider authorization; access through the [waitlist](https://adport.dev/#waitlist) |
| Runtime | Your machine, stdio MCP | Hosted dashboard, REST, and remote MCP |
| Credentials | Permission-restricted local file | Encrypted tenant vault |
| Approvals and audit | Local pending operations and JSONL log | Persistent tenant-scoped approvals and audit events |
| Policy and tools | Shared core and provider modules | Same core and provider modules |

The Cloud source is in `apps/cloud`. See [local Cloud development](docs/cloud/local-development.md), [hosted onboarding](docs/providers/cloud-onboarding.md), and the [deployment model](docs/cloud/deployment-model.md).

## Development

```sh
git clone https://github.com/ynnickw/adport.git
cd adport
corepack enable
pnpm install --frozen-lockfile
pnpm check
pnpm build
pnpm test
pnpm typecheck
```

The repository pins pnpm in `package.json`. Advertising credentials are unnecessary for the default build and tests. Optional database and HTTP integration checks are documented in the [Cloud development guide](docs/cloud/local-development.md).

| Path | Purpose |
| --- | --- |
| `packages/core` | Tool registry, policy engine, credentials, audit rules |
| `packages/{provider}` | Advertising platform adapters and wire-contract tests |
| `packages/cli`, `packages/mcp` | CLI and stdio MCP adapters |
| `apps/cloud` | Hosted dashboard, authorization, REST, remote MCP |
| `supabase` | Database migrations and tenant-isolation checks |
| `website`, `scripts` | Public site, generated pages, repository tooling |
| `plugins/adport` | Agent plugin manifests and skill |
| `docs` | User guides, operations, release and validation records |

See the [repository structure guide](docs/maintainers/repository-structure.md) for file ownership, generated assets, and directory conventions.

## Contributing and support

Bug fixes, documentation, provider tests, and practical feedback from advertisers are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md); commits require a DCO sign-off (`git commit -s`). The [release guide](docs/maintainers/releasing.md) explains versioning, verification, and publishing.

Use [GitHub issues](https://github.com/ynnickw/adport/issues/new/choose) for reproducible bugs and feature proposals. See [SUPPORT.md](SUPPORT.md) for help, [SECURITY.md](SECURITY.md) for private vulnerability reports, and the [Code of Conduct](CODE_OF_CONDUCT.md) for community expectations.

## License

[Apache License 2.0](LICENSE).
