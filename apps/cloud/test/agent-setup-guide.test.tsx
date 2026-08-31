import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AGENT_SETUPS, AgentSetupGuide } from '@/app/dashboard/agents/agent-setup-guide';

describe('Codex setup shared by onboarding and Agent access', () => {
  it.each(['https://app.adport.dev', 'http://127.0.0.1:3111'])('copies only the add command for %s', baseUrl => {
    const setup = AGENT_SETUPS.find(entry => entry.id === 'codex')!;
    expect(setup.command(baseUrl)).toBe(`codex mcp add adport --url ${baseUrl}/mcp`);
    expect(setup.command(baseUrl)).not.toContain('\n');
    expect(setup.command(baseUrl)).not.toContain('codex mcp login');
  });

  it('renders login as a conditional fallback, outside the copied code block', () => {
    const html = renderToStaticMarkup(<AgentSetupGuide baseUrl="https://app.adport.dev" initialSelectedId="codex" />);
    expect(html).toContain('<code>codex mcp add adport --url https://app.adport.dev/mcp</code>');
    expect(html).toContain('Run this command once');
    expect(html).toContain('Only if authorization did not start or you need to sign in again');
    expect(html).toContain('codex mcp login adport');
    expect(html).not.toContain('Run these commands once');
    expect(html).toContain('Copy Codex setup');
  });
});
