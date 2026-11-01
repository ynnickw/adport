export interface AgentSetup {
  id: string;
  name: string;
  provider: 'openai' | 'anthropic' | 'cursor' | 'mcp';
  label: string;
  instructions: string;
  nextStep: string;
  docsUrl: string;
  command: (baseUrl: string) => string;
  open?: { label: string; href: string };
}

export const AGENT_SETUPS: AgentSetup[];
export function cursorInstallUrl(baseUrl: string): string;
