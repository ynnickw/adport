# Adport plugin

Adport gives ChatGPT, Codex, and Claude Code the same normalized paid-media tools over one hosted MCP endpoint. It supports account inventory, reporting, audit findings, recommendations, and structurally guarded writes across Adport's approved provider integrations.

The hosted plugin authenticates with Adport Cloud through OAuth. Provider passwords and application secrets are never entered into the agent. Every write is previewed first and can be applied only by repeating the exact arguments with the returned pending-operation id.

## Claude Code development

Load this repository package directly:

```sh
claude --plugin-dir ./plugins/adport
```

Then run `claude plugin validate ./plugins/adport` before publishing. Third-party public submissions use Anthropic's official plugin directory form and, after approval, the `anthropics/claude-plugins-official` marketplace.

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
