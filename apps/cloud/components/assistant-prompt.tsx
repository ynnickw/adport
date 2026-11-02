import { CopyButton } from '@/app/dashboard/agents/agent-setup-guide';

export function AssistantPrompt({ baseUrl, projectName, assistantName, authorized, verified }: {
  baseUrl: string; projectName: string; assistantName: string; authorized: boolean; verified: boolean;
}) {
  const assistant = assistantName === 'Any MCP client' ? 'your assistant' : assistantName;
  const project = JSON.stringify(projectName);
  const content = verified ? {
    title: 'Get started',
    description: `Paste this into ${assistant} for your first performance review.`,
    prompt: `Use Adport for the project ${project}. Review the last 7 days of performance across its enabled ad accounts. Show spend, conversions, and the biggest changes to investigate. Keep each currency separate and suggest what to review next. If this project is not available, ask me to reconnect to it. Do not make any ad changes.`,
    label: 'Copy starter prompt',
  } : authorized ? {
    title: 'Check your connection',
    description: `Open a chat in ${assistant} with Adport enabled, then paste this prompt.`,
    prompt: `Use Adport to list the enabled ad accounts available in the project ${project}. Confirm their names and ad platforms. If this project or its accounts are not available, tell me which connection or access step is needed. Do not make any ad changes.`,
    label: 'Copy verification prompt',
  } : {
    title: 'Set up with your assistant',
    description: `Paste this into ${assistant} to get help connecting this project.`,
    prompt: `Help me connect Adport to ${assistantName === 'Any MCP client' ? 'my AI assistant' : assistantName}. The server URL is ${new URL('/mcp', baseUrl).href}. Guide me through setup and browser sign-in, and ask me to authorize the project ${project}. Then use Adport to list this project's enabled ad accounts and confirm the connection. Do not make any ad changes.`,
    label: 'Copy setup prompt',
  };

  return <div className="setup-first-question">
    <h3>{content.title}</h3>
    <p>{content.description}</p>
    <blockquote>{content.prompt}</blockquote>
    <CopyButton key={content.label + content.prompt} value={content.prompt} label={content.label} />
  </div>;
}
