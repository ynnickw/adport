# Adport plugin

Adport gives ChatGPT, Codex, and Claude Code the same normalized paid-media tools over one hosted MCP endpoint. It supports account inventory, reporting, audit findings, recommendations, and structurally guarded writes across Adport's approved provider integrations.

The hosted plugin authenticates with Adport Cloud through OAuth. Provider passwords and application secrets are never entered into the agent. Every write is previewed first and can be applied only by repeating the exact arguments with the returned pending-operation id.

## Claude Code development

Load this repository package directly:

```sh
claude --plugin-dir ./plugins/adport
```

Then run `claude plugin validate ./plugins/adport --strict` before publishing. Third-party public submissions use Anthropic's Console submission form and, after review, the `anthropics/claude-plugins-community` marketplace.

## Example prompts

- "Use Adport to list the advertising accounts enabled for my workspace, including provider and currency."
- "Report the last 30 days for my selected account. Keep currencies separate and say when there are no reporting rows. Do not change anything."
- "Preview pausing this campaign and show the exact before and after. Do not apply the change until I approve that preview."

Sign in to Adport through the plugin's OAuth connection. A workspace administrator must authorize a provider and enable the intended account for agent access first. Available tools depend on connected providers, workspace role and plan. If a tool is missing, do not substitute a different account or bypass the workspace's policy.

## Data and support

The skill uses only the declared Adport MCP connection. It does not send conversation history to another service. Adport Cloud stores account identity and membership information, connection metadata, short-lived pending operations and audit records needed for the requested workflows. Audit retention is configurable; live report results are not durably stored by default. Provider credentials stay in Adport's encrypted vault and are not returned to Claude.

- [Privacy policy](https://adport.dev/privacy)
- [Terms of service](https://adport.dev/terms)
- [Support](https://adport.dev/support)
- [Documentation](https://github.com/ynnickw/adport#readme)

## OpenAI development

The package contains a Codex manifest and the same provider-neutral skill. The production submission uses `https://app.adport.dev/mcp` with OAuth 2.1; local `stdio` transport is not part of the hosted marketplace submission.

## Local open-source workflow

The free local CLI and MCP server remain separate from Adport Cloud:

```sh
npm install -g adport
adport connect google
adport mcp
```

See [adport.dev](https://adport.dev) for public privacy, terms, and data-deletion information.
