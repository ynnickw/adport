export function adportToolSearchConfig(baseUrl: string) {
  const url = new URL('/mcp', baseUrl).href;
  const authorization = 'YOUR_ADPORT_API_KEY';
  return [
    {
      name: 'OpenAI Responses API',
      docsUrl: 'https://developers.openai.com/api/docs/guides/tools-tool-search',
      config: JSON.stringify({ tools: [
        { type: 'tool_search' },
        {
          type: 'mcp',
          server_label: 'adport',
          server_description: 'Adport provides project-scoped ad account reporting, campaign and creative inspection, specialist workflows, and policy-checked change previews.',
          server_url: url,
          authorization,
          defer_loading: true,
        },
      ] }, null, 2),
    },
    {
      name: 'Claude Messages API',
      docsUrl: 'https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool',
      header: 'anthropic-beta: mcp-client-2025-11-20',
      config: JSON.stringify({
        mcp_servers: [{ type: 'url', url, name: 'adport', authorization_token: authorization }],
        tools: [
          { type: 'tool_search_tool_bm25_20251119', name: 'tool_search_tool_bm25' },
          { type: 'mcp_toolset', mcp_server_name: 'adport', default_config: { defer_loading: true } },
        ],
      }, null, 2),
    },
  ];
}
