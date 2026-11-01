// Shared by the Cloud dashboard, onboarding, and generated public setup guides.
export const AGENT_SETUPS = [
  {
    id: 'chatgpt', name: 'ChatGPT', provider: 'openai', label: 'Web',
    instructions: 'Open Plugins, choose +, then Add custom MCP server. Name it Adport, paste this server URL, and choose OAuth.',
    nextStep: 'Create the plugin, sign in to Adport, and install it. In a new chat, type @ and select Adport before asking your first question.',
    command: baseUrl => `${baseUrl}/mcp`,
    open: { label: 'Open ChatGPT Plugins', href: 'https://chatgpt.com/plugins' },
    docsUrl: 'https://developers.openai.com/api/docs/guides/custom-mcp-server',
  },
  {
    id: 'codex', name: 'Codex', provider: 'openai', label: 'App, CLI & IDE',
    instructions: 'Run this command in your terminal. It adds Adport to the MCP configuration shared by your local Codex clients.',
    nextStep: 'Complete the browser sign-in when prompted. If sign-in has not started, run the command below.',
    command: baseUrl => `codex mcp add adport --url ${baseUrl}/mcp`,
    docsUrl: 'https://developers.openai.com/codex/mcp/',
  },
  {
    id: 'claude', name: 'Claude', provider: 'anthropic', label: 'Web & Desktop',
    instructions: 'Open Customize → Connectors, choose + Add, then Add custom connector. Name it Adport and paste this server URL.',
    nextStep: 'Keep sign-in enabled and finish connecting to Adport. In your conversation, open + → Connectors and enable Adport.',
    command: baseUrl => `${baseUrl}/mcp`,
    open: { label: 'Open Claude Connectors', href: 'https://claude.ai/customize/connectors' },
    docsUrl: 'https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp',
  },
  {
    id: 'claude-code', name: 'Claude Code', provider: 'anthropic', label: 'Terminal',
    instructions: 'Run this command in your terminal. User scope makes Adport available across your local Claude Code projects.',
    nextStep: 'Open Claude Code and run /mcp. Select Adport and follow the browser sign-in.',
    command: baseUrl => `claude mcp add --transport http --scope user adport ${baseUrl}/mcp`,
    docsUrl: 'https://code.claude.com/docs/en/mcp',
  },
  {
    id: 'cursor', name: 'Cursor', provider: 'cursor', label: 'Editor',
    instructions: 'Open the install link and confirm Add in Cursor. Adport uses browser sign-in, so no API key is needed.',
    nextStep: 'Complete the sign-in from Cursor’s MCP settings, then start a conversation with Agent.',
    command: baseUrl => JSON.stringify({ mcpServers: { adport: { url: `${baseUrl}/mcp` } } }, null, 2),
    docsUrl: 'https://cursor.com/docs/mcp',
  },
  {
    id: 'mcp', name: 'Any MCP client', provider: 'mcp', label: 'Any MCP client',
    instructions: 'Add a remote MCP server in your assistant. Name it Adport, paste this URL, and choose Streamable HTTP with OAuth.',
    nextStep: 'Follow your assistant’s sign-in prompt. If it does not support OAuth, an admin can create an API key under Advanced on the AI assistants page.',
    command: baseUrl => `${baseUrl}/mcp`,
    docsUrl: 'https://modelcontextprotocol.io/docs/develop/connect-remote-servers',
  },
];

export function cursorInstallUrl(baseUrl) {
  const config = btoa(JSON.stringify({ url: new URL('/mcp', baseUrl).href }));
  return `cursor://anysphere.cursor-deeplink/mcp/install?name=adport&config=${encodeURIComponent(config)}`;
}

