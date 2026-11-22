import { ADPORT_CLOUD_URL, AGENT_SETUPS } from '../../apps/cloud/lib/agent-setups.mjs';
export { CHATGPT_PLUGIN_URL, cursorInstallUrl } from '../../apps/cloud/lib/agent-setups.mjs';

export const mcpBaseUrl = ADPORT_CLOUD_URL;
export const cloudSignInUrl = `${mcpBaseUrl}/login`;
export const cloudSignupUrl = `${cloudSignInUrl}?mode=signup`;
export const agentSetups = AGENT_SETUPS.map(setup => ({
  ...setup,
  logo: { openai: 'chatgpt', anthropic: 'claude', cursor: 'cursor', mcp: 'mcp' }[setup.provider],
}));
