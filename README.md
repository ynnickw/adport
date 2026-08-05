# adport

> Open-source multi-platform ads management for AI agents. Connect your Google Ads, Meta Ads, and TikTok Ads accounts once, then monitor and manage them by talking to any agent — through an MCP server and CLI, with real read *and* write access behind auditable safety rails.

**Status: v0 (unpublished).** Google Ads works end-to-end (read + write behind the policy engine); Meta is next, TikTok after. See [start-spec.md](./start-spec.md) for the full plan.

## Why

- **Agent-first.** The product surface is an MCP server and a CLI — connect it to Claude, Cursor, or any agent and talk to your ads.
- **Genuinely open.** The entire multi-platform core is Apache-2.0 and self-hostable with your own API credentials.
- **Writes with structural safety.** Every mutation is two-step: a dry-run returns a preview and a `pending_operation_id`; applying requires that ID. Created entities are paused by default, budget changes are capped by policy, and everything lands in an audit log.
- **Connection as a product.** `adport connect <provider>` walks you through each platform's credential maze (and yes — since Google's Explorer tier, a fresh Google Ads developer token works the same day).

## Repo layout

```
packages/
  core/    @adport/core   — provider interface, tool registry, policy engine, credential store
  mcp/     @adport/mcp    — MCP server (stdio) over the shared tool registry
  cli/     adport         — CLI over the same tool registry
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
