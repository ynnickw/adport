'use client';

import { useState } from 'react';
import { CopyButton } from '@/app/dashboard/agents/agent-setup-guide';

export function AssistantPrompt({ projectName, verified }: { projectName: string; verified: boolean }) {
  const [failedPrompt, setFailedPrompt] = useState<string>();
  const project = JSON.stringify(projectName);
  const content = verified ? {
    title: 'Review your performance',
    description: 'Paste the starter prompt into a chat to review the last 7 days.',
    prompt: `Use Adport for the project ${project}. Review the last 7 days of performance across its enabled ad accounts. Show spend, conversions, and the biggest changes to investigate. Keep each currency separate and suggest what to review next. If this project is not available, ask me to reconnect to it. Do not make any ad changes.`,
    label: 'Copy starter prompt',
  } : {
    title: 'Try a test read',
    description: 'This is optional. Paste this prompt in a chat to check access.',
    prompt: `Use Adport to list the enabled ad accounts available in the project ${project}. Confirm their names and ad platforms. If this project or its accounts are not available, tell me which connection or access step is needed. Do not make any ad changes.`,
    label: 'Copy verification prompt',
  };

  return <div className="setup-first-question">
    <div><h3>{content.title}</h3><p>{content.description}</p></div>
    <CopyButton key={content.label + content.prompt} value={content.prompt} label={content.label} onCopyFailure={() => setFailedPrompt(content.prompt)} />
    {failedPrompt === content.prompt ? <textarea className="setup-prompt-fallback" aria-label="Prompt to copy manually" readOnly rows={4} value={content.prompt} onFocus={event => event.currentTarget.select()} /> : null}
  </div>;
}
