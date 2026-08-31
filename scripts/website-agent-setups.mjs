// Kept in parity with apps/cloud/app/dashboard/agents/agent-setup-guide.tsx by tests.
export const mcpBaseUrl = 'https://app.adport.dev';
export const agentSetups = [
  {
    id: 'chatgpt', name: 'ChatGPT', logo: 'chatgpt',
    instructions: 'Enable developer mode, then open Settings → Apps → Create. Choose OAuth and use the endpoint below.',
    nextStep: 'Scan the tools, finish Adport authorization, and enable the new app in your chat.',
    command: baseUrl => `${baseUrl}/mcp`,
  },
  {
    id: 'codex', name: 'Codex', logo: 'chatgpt',
    instructions: 'Run this command once and complete the browser authorization. Codex stores the MCP configuration and starts OAuth automatically.',
    nextStep: 'Only if authorization did not start or you need to sign in again, run “codex mcp login adport”. Otherwise, check “codex mcp list” and ask Codex to list your ad accounts.',
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
    id: 'vscode', name: 'VS Code', logo: 'vscode',
    instructions: 'Open the Command Palette and choose “MCP: Open User Configuration”, then add this server.',
    nextStep: 'Start the Adport server from VS Code and complete the browser authorization.',
    command: baseUrl => JSON.stringify({ servers: { adport: { type: 'http', url: `${baseUrl}/mcp` } } }, null, 2),
  },
];
