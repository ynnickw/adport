# Adport tool search

Use the Standard profile scoped to the project's connected providers for everyday workflows. Full exposes specialist operations. An API client can defer the tools it already has access to. If the profile hides an operation, `capabilities_list` can explain how to enable it. The connector's discovery response and directory review still use the selected profile's tool catalog.

## Configure an API client

In Adport Cloud, open **AI assistants → Advanced: API keys & custom integrations → Tool search for OpenAI and Claude APIs** for copyable request fields. New keys default to Standard with the project's connected providers. Choose Full for a key used for specialist workflows.

For the [OpenAI Responses API](https://developers.openai.com/api/docs/guides/tools-connectors-mcp#defer-loading-tools-in-an-mcp-server), use a [model that supports tool search](https://developers.openai.com/api/docs/guides/tools-tool-search). In the request's `tools` array, add `tool_search` and defer the MCP server. Supply the Adport OAuth access token for the authorized project in `authorization`.

```json
[
  { "type": "tool_search" },
  {
    "type": "mcp",
    "server_label": "adport",
    "server_description": "Adport manages project-scoped ad accounts across Google, Meta, and other platforms. Use it for performance reports, campaign and creative inspection, specialist workflows, and policy-checked previews.",
    "server_url": "https://app.adport.dev/mcp",
    "defer_loading": true
  }
]
```

For the [Claude Messages API](https://platform.claude.com/docs/en/agents-and-tools/mcp-connector), send `anthropic-beta: mcp-client-2025-11-20`. Add the server to `mcp_servers` using its name, URL and `authorization_token`. Add the [BM25 search tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool) and configure the matching MCP toolset in `tools`.

```json
[
  { "type": "tool_search_tool_bm25_20251119", "name": "tool_search_tool_bm25" },
  {
    "type": "mcp_toolset",
    "mcp_server_name": "adport",
    "default_config": { "defer_loading": true }
  }
]
```

For an eager baseline, omit the search tool and the deferral setting. Leave Adport's two-step preview and apply policy in place. These examples configure API requests. [Claude Code enables tool search by default](https://code.claude.com/docs/en/mcp#configure-tool-search) and uses `ENABLE_TOOL_SEARCH` for local comparison runs.

## Reproduce the benchmark

From the repository root after installing workspace dependencies and building the packages:

```sh
catalogs="$PWD/artifacts/connectors/tool-benchmark"
ADPORT_TOOL_BENCHMARK_CATALOGS="$catalogs" pnpm --filter @adport/cloud test test/mcp-full-catalog.test.ts
node scripts/connectors/benchmark-tool-search.mjs --catalogs "$catalogs" --output "$catalogs/results" --client claude --model claude-sonnet-5-5
node scripts/connectors/benchmark-tool-search.mjs --catalogs "$catalogs" --output "$catalogs/results" --client codex --model gpt-6.1-sol
```

The export uses the hosted `tools/list` route with mocked authentication and repository data. The runners use the exported definitions, two synthetic projects and synthetic tool results. The scoring checks tool choice, arguments, project scope, answer contents and apply attempts. A local MCP fixture always rejects apply calls.

Use `--client openai-api` with `OPENAI_API_KEY` or `--client claude-api` with `ANTHROPIC_API_KEY` to compare API-native search with eager loading. These modes send the same input schemas as function definitions and execute synthetic results locally. The remote MCP examples above are for integrating a real connection. Use a dedicated test project for a remote integration check. The benchmark writes per-task token usage, wall time, search counts where visible, pass/fail, and tool traces. Use `--case`, `--profile`, and `--loading` to select a subset.

## Baseline from November 13, 2026

Catalog bytes are the serialized legacy MCP discovery response. Standard is 77% smaller with all providers enabled and 92% smaller when scoped to Google and Meta.

| Profile | Tools | Discovery bytes |
| --- | ---: | ---: |
| Standard, Google and Meta | 62 | 290,639 |
| Standard, all providers | 220 | 892,150 |
| Full | 871 | 3,868,791 |

Claude Code 2.1.311 with Sonnet 5.5 ran four fresh sessions per configuration, one each for a report, a budget preview, a Meta pixel lookup and a general-knowledge control. The specialist task passes under Standard if the assistant finds the hidden operation and explains how to enable it. Under Full, the same task requires returning the fixture's pixel.

| Profile | Loading | Passed | Median first-request input | Median total input | Median wall time |
| --- | --- | ---: | ---: | ---: | ---: |
| Standard, Google and Meta | Eager | 3/4 | 39,720 | 120,031 | 5.2 s |
| Standard, Google and Meta | Deferred | 4/4 | 3,050 | 15,515 | 6.9 s |
| Full | Eager | 4/4 | 726,870 | 2,181,355 | 6.6 s |
| Full | Deferred | 4/4 | 21,015 | 86,956 | 6.8 s |

Codex CLI 0.166.0 with GPT-6.1 Sol used its default tool loading. Both profiles passed all four tasks. Standard used a median of 60,855 total input tokens per task, compared with 91,275 for Full. Median wall time was 28.3 s for Standard and 19.7 s for Full.

Input includes cached tokens. Total input sums model turns within a task and can exceed the context of any single request. Claude's Standard eager run recovered from one unscoped call to `capabilities_list` and gave the right enablement instructions. The scope check counts that retry as a failure. All runs stopped before applying the budget change. With four prompts per configuration and unbalanced cache warming, treat latency, cost and success rates as directional. The direct API runners passed mocked transport checks. The run used local clients and did not measure directory-host behavior.
