// Kept in parity with apps/cloud/app/dashboard/agents/agent-setup-guide.tsx by tests.
export const mcpBaseUrl = 'https://app.adport.dev';
export const agentSetups = [
  {
    id: 'chatgpt', name: 'ChatGPT', logo: 'chatgpt',
    instructions: 'In Plugins, add a custom MCP server and name it Adport. Choose OAuth, then enter the address below.',
    nextStep: 'Create the plugin, finish Adport authorization, install it, then select it with @ in your chat.',
    command: baseUrl => `${baseUrl}/mcp`,
  },
  {
    id: 'codex', name: 'Codex', logo: 'chatgpt',
    instructions: 'Register Adport with this command. Complete the browser authorization if prompted.',
    nextStep: 'If sign-in has not started, run “codex mcp login adport”, then use “codex mcp list” to check the connection.',
    command: baseUrl => `codex mcp add adport --url ${baseUrl}/mcp`,
  },
  {
    id: 'claude-code', name: 'Claude Code', logo: 'claude',
    instructions: 'Add Adport at user scope so it is available across your local projects.',
    nextStep: 'Run /mcp inside Claude Code if the browser authorization does not open automatically.',
    command: baseUrl => `claude mcp add --transport http --scope user adport ${baseUrl}/mcp`,
  },
  {
    id: 'claude', name: 'Claude', logo: 'claude',
    instructions: 'Open Customize → Connectors → Add custom connector. Name it Adport and use the endpoint below.',
    nextStep: 'Select Connect, approve the workspace, then enable Adport from the + menu in a conversation.',
    command: baseUrl => `${baseUrl}/mcp`,
  },
  {
    id: 'cursor', name: 'Cursor', logo: 'cursor',
    instructions: 'Add this server to ~/.cursor/mcp.json, then restart Cursor.',
    nextStep: 'Approve the browser sign-in when prompted. Cursor will keep the OAuth session refreshed.',
    command: baseUrl => JSON.stringify({ mcpServers: { adport: { url: `${baseUrl}/mcp` } } }, null, 2),
  },
  {
    id: 'mcp', name: 'Any MCP client', logo: 'mcp',
    instructions: 'Add a remote MCP server in your client, name it Adport, and use the endpoint below. Choose OAuth or streamable HTTP if your client asks.',
    nextStep: 'Approve the browser sign-in when prompted. For a client without MCP OAuth, create an API key under Agent access instead.',
    command: baseUrl => `${baseUrl}/mcp`,
  },
];
