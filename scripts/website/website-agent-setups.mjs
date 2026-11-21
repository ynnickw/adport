import { AGENT_SETUPS } from '../../apps/cloud/lib/agent-setups.mjs';
export { cursorInstallUrl } from '../../apps/cloud/lib/agent-setups.mjs';

export const mcpBaseUrl = 'https://app.adport.dev';
export const cloudSignInUrl = `${mcpBaseUrl}/login`;
export const cloudSignupUrl = `${cloudSignInUrl}?mode=signup`;
export const agentSetups = AGENT_SETUPS.map(setup => ({
  ...setup,
  logo: { openai: 'chatgpt', anthropic: 'claude', cursor: 'cursor', mcp: 'mcp' }[setup.provider],
}));
