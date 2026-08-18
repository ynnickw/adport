# adport

> The open control plane for paid media. Manage Google, Meta, TikTok, Apple, Microsoft, and Reddit Ads from the terminal or any AI agent—with every write previewed first.

I built adport because I wanted an agent to help with ad operations, but I did not want a prompt to be the only thing standing between the agent and an expensive change.

adport is an Apache-2.0 CLI, local MCP server, and locally runnable cloud application. It connects to your ad accounts, gives every client the same typed tools, normalizes reporting across providers, and makes every write show a preview before the exact approved change can run. The released CLI remains self-hosted with credentials on your machine and no telemetry; the cloud application is implemented for local verification but is not yet a public production service.

Google Ads, Apple Ads, and Microsoft Advertising have been exercised against live accounts. Meta and TikTok are implemented, but still need more testing with advertisers who use them day to day. If that is you, I would love to test and improve the integration with you.

## Install

Requires Node.js 22.13 or newer.

```sh
npm install -g adport
adport --version
```

Connect a provider and confirm the account is available:

```sh
adport connect google
adport accounts
adport doctor
```

Adport fails closed when no provider credentials are available: it exposes the core/audit tool definitions, but account, report, and audit operations return `NOT_CONNECTED`. It never substitutes demo accounts in a normal runtime.

To explore synthetic data explicitly, opt into demo mode:

```sh
adport --demo accounts
adport --demo report --range last_7_days
adport --demo mcp
```

For an MCP host that configures environment variables instead of arguments, `ADPORT_DEMO=true` enables the same isolated mock provider. Mock tools are always named `mock_*` and never call an advertising platform.

Then pull a normalized report:

```sh
adport report --provider google --metrics spend,clicks,conversions,roas --range last_7_days
```

Supported connection commands:

```sh
adport connect google
adport connect meta
adport connect tiktok
adport connect apple
adport connect microsoft
adport connect reddit
```

These are deliberately **local/BYO** connections. You create and own each provider app, developer token, or API key; the CLI talks directly to the provider and writes secrets only to `${ADPORT_HOME:-~/.config/adport}/credentials.json` with mode `0600`. Adport Cloud and its hosted OAuth broker are not involved. Provider review, consent warnings, and tenant policies therefore belong to your provider app. Remove a stored connection with `adport disconnect <provider>`; revoke the credential separately at the provider when necessary.

The cloud application in `apps/cloud` is a separate flow. Every OAuth-capable provider (Google, Meta, TikTok, Microsoft, Reddit) is connected through a hosted OAuth broker backed by Adport-owned, reviewed applications; tenants never paste application secrets, and each provider card activates once its application is approved and configured. Apple Ads, which has no third-party OAuth grant, accepts a tenant API-user key. All six providers share an encrypted tenant vault and the remote REST/MCP runtime.

The complete credential and authorization checklist is in [docs/providers.md](./docs/providers.md). Never commit provider tokens, app secrets, refresh tokens, or private keys.

## Use it with Claude Code

After installing adport and connecting a provider:

```sh
claude mcp add adport -- adport mcp
```

Restart Claude Code, then ask it to list your ad accounts or report campaign performance. The same stdio server works with other MCP clients:

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

The CLI is not a separate implementation. `adport accounts`, `adport report`, and `adport tools run` use the same tool registry and policy engine exposed through MCP.

## What happens before a write

Every mutation uses the same two-step contract:

1. The first call can only return a dry-run preview.
2. The preview includes the proposed changes, coercions, budget deltas, and a short-lived `pending_operation_id`.
3. Applying requires a second call with that ID and identical arguments.

Changed arguments, expired approvals, protected accounts, and budget-cap violations are rejected. New campaigns are created paused, coercions are always reported, and applied changes are written to an append-only local audit log.

Use the CLI to inspect the active policy and audit trail:

```sh
adport policy
adport audit show
```

Policy lives at `~/.config/adport/policy.yaml`; credentials live at `~/.config/adport/credentials.json` with local-only file permissions.

## Provider status

| Provider | Reads | Writes | Provider-side validation | Current validation |
| --- | --- | --- | --- | --- |
| Google Ads | GAQL and normalized reports | campaigns, ad groups, keywords, RSAs, budgets, bidding | `validate_only` | exercised against a live account |
| Meta Ads | Insights and normalized reports | campaigns, ad sets, budgets, status | `execution_options=["validate_only"]` | needs more real-account testing |
| TikTok Ads | reporting and normalized reports | campaigns, budgets, status | client-side preview; sandbox available | needs sandbox and production testers |
| Apple Ads | campaign reports and normalized reports | campaigns, budgets, status | client-side preview | exercised against a live account |
| Microsoft Advertising | asynchronous reports and normalized reports | campaigns, budgets, status | client-side preview; sandbox available | exercised against a live account |
| Reddit Ads | v3 reports and normalized reports | campaigns, CBO budgets, status | client-side preview | wire schemas verified; needs a real-account tester |

Apple Campaign Management API v5 sunsets in January 2027. Its client is version-isolated so the future Ads Platform API migration does not leak into the shared tool layer.

## Help test a provider

If you currently run ads on Meta, TikTok, Apple, Microsoft, or Google, practical workflow feedback is more useful than a star.

Start with connection health and reads, or use a provider sandbox where available:

```sh
adport connect <provider>
adport doctor
adport accounts --provider <provider>
adport report --provider <provider> --range last_7_days
```

If something fails or a workflow is missing, [open an issue](https://github.com/ynnickw/adport/issues) with the provider, command, expected result, and sanitized error. Do not include credentials, account details, access tokens, or private request data. I am especially interested in working with active advertisers on authentication edge cases, reporting fields, safe write previews, and the first useful provider-specific audit rules.

## Findings instead of an account score

`adport audit run` evaluates pluggable rule packs over normalized campaign data and persists concrete findings such as zero-conversion spend, low CTR, CPA outliers, and below-break-even ROAS.

```sh
adport audit run
adport recommendations list
```

Recommendations remain open until they are dismissed or applied. Any proposed fix goes through the normal preview-and-approve gate. There is deliberately no account score: a concrete finding with evidence is more useful than a gameable number.

## Reporting and audit semantics

Normalized metric definitions, currency behavior, date boundaries, attribution limits, and safe cross-provider comparison rules are documented in [docs/reporting-semantics.md](./docs/reporting-semantics.md). Provider reporting is not silently currency-converted and does not erase platform attribution differences.

Write-audit entries are append-only JSONL locally. Inspect or export them without changing the source log:

```sh
adport audit show --limit 50
adport audit export --format jsonl > adport-audit.jsonl
adport audit export --format json > adport-audit.json
```

The policy contract and audit event schema are documented in [docs/write-safety.md](./docs/write-safety.md).

## Self-hosted and cloud modes

The CLI and stdio MCP server remain local and BYO. They do not contact Adport Cloud.

The repository now also contains a Next.js/Supabase cloud control center with tenant authentication and roles, RLS, encrypted multi-provider credentials, a hosted OAuth broker for Google, Meta, TikTok, Microsoft, and Reddit (PKCE/one-time state, revocation on disconnect), scoped API keys, a remote MCP endpoint, persistent pending approvals/audit events, retention, revocation, and organization deletion. It reuses the same provider modules, tool registry, and policy engine; it does not create a second write path. The implementation is local-first and still has explicit production gates. See [docs/deployment-model.md](./docs/deployment-model.md) and [docs/cloud-local-development.md](./docs/cloud-local-development.md).

## Development

```sh
git clone https://github.com/ynnickw/adport.git
cd adport
corepack enable
pnpm install
pnpm build
pnpm test
pnpm typecheck

# Optional local cloud stack
supabase start
supabase db reset --local --yes
pnpm --filter @adport/cloud dev
```

Repository layout:

```text
packages/
  core/       shared tool registry, policy engine, audit harness, credentials
  google/     Google Ads provider
  meta/       Meta Marketing API provider
  tiktok/     TikTok Business API provider
  apple/      Apple Ads provider
  microsoft/  Microsoft Advertising provider
  reddit/     Reddit Ads API v3 provider
  mcp/        stdio MCP adapter over the shared registry
  cli/        npm CLI over the shared registry
apps/
  cloud/      Next.js/Supabase tenant dashboard, OAuth broker, REST, and remote MCP
supabase/
  migrations/ tenant schema, RLS, backend grants, retention, and database tests
```

Provider tests assert outgoing API wire formats, unit conversions, headers, and validation behavior. Every new write path must go through the shared policy engine.

## License

[Apache-2.0](./LICENSE). Contributions require a DCO sign-off (`git commit -s`); see [CONTRIBUTING.md](./CONTRIBUTING.md).
