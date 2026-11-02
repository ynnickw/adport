'use client';

import { useState } from 'react';
import { CopyButton } from '@/app/dashboard/agents/agent-setup-guide';

export function AssistantPrompt({ baseUrl, projectName, assistantName, authorized, verified }: {
  baseUrl: string; projectName: string; assistantName: string; authorized: boolean; verified: boolean;
}) {
  const [failedPrompt, setFailedPrompt] = useState<string>();
  const project = JSON.stringify(projectName);
  const content = verified ? {
    title: 'Review your performance',
    description: 'Copy a question about the last 7 days and paste it into your assistant.',
    prompt: `Use Adport for the project ${project}. Review the last 7 days of performance across its enabled ad accounts. Show spend, conversions, and the biggest changes to investigate. Keep each currency separate and suggest what to review next. If this project is not available, ask me to reconnect to it. Do not make any ad changes.`,
    label: 'Copy starter prompt',
  } : authorized ? {
    title: 'Check your connection',
    description: 'Copy this question into a chat with Adport enabled to verify access.',
    prompt: `Use Adport to list the enabled ad accounts available in the project ${project}. Confirm their names and ad platforms. If this project or its accounts are not available, tell me which connection or access step is needed. Do not make any ad changes.`,
    label: 'Copy verification prompt',
  } : {
    title: 'Need help connecting?',
    description: 'Copy the setup prompt into your assistant for step-by-step help.',
    prompt: `Help me connect Adport to ${assistantName === 'Any MCP client' ? 'my AI assistant' : assistantName}. The server URL is ${new URL('/mcp', baseUrl).href}. Guide me through setup and browser sign-in, and ask me to authorize the project ${project}. Then use Adport to list this project's enabled ad accounts and confirm the connection. Do not make any ad changes.`,
    label: 'Copy setup prompt',
  };

  return <div className="setup-first-question">
    <div><h3>{content.title}</h3><p>{content.description}</p></div>
    <CopyButton key={content.label + content.prompt} value={content.prompt} label={content.label} onCopyFailure={() => setFailedPrompt(content.prompt)} />
    {failedPrompt === content.prompt ? <textarea className="setup-prompt-fallback" aria-label="Prompt to copy manually" readOnly rows={4} value={content.prompt} onFocus={event => event.currentTarget.select()} /> : null}
  </div>;
}
