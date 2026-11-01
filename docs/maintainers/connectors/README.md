# Connector maintenance

These are maintainer review guides, separate from the [local CLI and MCP setup](../../../README.md#connect-an-ai-agent) and the [distributable agent plugin](../../../plugins/adport/README.md).

- [OpenAI connector review guide](openai-plugin.md)
- [Anthropic connector review guide](anthropic-connector.md)
- [Production review gate](production-readiness.md)
- [Generate portal icons](icons.md)
- [Historical verification records](archive/README.md)

Review guides contain dated observations. Recheck provider permissions, host behavior, and portal requirements before a new submission; source availability is not evidence of approval.

Render fixture previews with `pnpm --filter @adport/mcp render:submission-previews`. Outputs go to ignored `artifacts/connectors/previews/`; portal icon exports go to `artifacts/connectors/icons/`. Generate fresh files for inspection and upload instead of committing reproducible exports. In-host captures and their historical evidence boundaries remain in the archive.
