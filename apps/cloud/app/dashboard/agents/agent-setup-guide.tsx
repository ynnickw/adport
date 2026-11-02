'use client';

import { Button, Disclosure } from '@/components/controls';
import { useState } from 'react';
import { SiClaude, SiCursor, SiModelcontextprotocol } from 'react-icons/si';

import { AGENT_SETUPS, cursorInstallUrl, type AgentSetup } from '@/lib/agent-setups.mjs';
export { AGENT_SETUPS, cursorInstallUrl } from '@/lib/agent-setups.mjs';

export const STARTER_PROMPTS = [
  { label: 'Performance', text: 'Use Adport to summarize my ad performance over the last 7 days. Show spend, conversions, and the biggest change to investigate. Do not make any changes.' },
  { label: 'Find wasted spend', text: 'Use Adport to find where my ad budget may be wasted. Explain the evidence and suggest what to review first. Do not make any changes.' },
  { label: 'Audit my accounts', text: 'Run an Adport audit of my enabled ad accounts. Explain the most important findings and recommended next steps. Do not apply any changes.' },
];

function OpenAiLogo() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z" />
    </svg>
  );
}

export function AgentLogo({ provider }: { provider: AgentSetup['provider'] }) {
  if (provider === 'openai') return <OpenAiLogo />;
  if (provider === 'anthropic') return <SiClaude aria-hidden="true" />;
  if (provider === 'cursor') return <SiCursor aria-hidden="true" />;
  return <SiModelcontextprotocol aria-hidden="true" />;
}

export function AgentIdentityLogo({ name }: { name: string }) {
  const setup = AGENT_SETUPS.find(item => item.name.toLowerCase() === name.toLowerCase());
  return <span className={`agent-logo ${setup?.provider ?? 'mcp'}`} aria-hidden="true">{setup ? <AgentLogo provider={setup.provider} /> : name.slice(0, 1).toUpperCase()}</span>;
}

export function CopyButton({ value, label, className = '', onCopyFailure }: { value: string; label: string; className?: string; onCopyFailure?: () => void }) {
  const [status, setStatus] = useState<'idle' | 'copied' | 'failed'>('idle');
  async function copy() {
    try { await navigator.clipboard.writeText(value); setStatus('copied'); }
    catch { setStatus('failed'); onCopyFailure?.(); }
  }
  return <Button className={'button secondary small ' + className} type="button" onClick={() => void copy()} aria-label={label}><span aria-live="polite">{status === 'failed' ? 'Select text to copy' : status === 'copied' ? 'Copied ✓' : label}</span></Button>;
}

export function AgentSetupGuide({ baseUrl, projectName, initialSelectedId, onSelectionChange, canCheckConnection = false, hasConnections = false, variant = 'default' }: { baseUrl: string; projectName?: string; initialSelectedId?: string; onSelectionChange?: (id: string) => void; canCheckConnection?: boolean; hasConnections?: boolean; variant?: 'default' | 'onboarding' }) {
  const [selectedId, setSelectedId] = useState(initialSelectedId ?? AGENT_SETUPS[0]!.id);
  const [promptIndex, setPromptIndex] = useState(0);
  const selected = AGENT_SETUPS.find(setup => setup.id === selectedId) ?? AGENT_SETUPS[0]!;
  const command = selected.command(baseUrl);
  const isCommand = selected.id === 'codex' || selected.id === 'claude-code';
  const prompt = STARTER_PROMPTS[promptIndex]!;
  const instructionId = `assistant-instructions-${variant}`;

  return <section className={'card assistant-setup' + (variant === 'onboarding' ? ' onboarding-agent-setup' : '')} aria-label="Connect an AI assistant">
    <div className="card-head"><div><h2>{hasConnections ? 'Connect another assistant' : 'Which assistant do you use?'}</h2><p className="card-kicker">Connect with your Adport login. No API key needed.</p></div></div>
    <div className="assistant-picker" role="group" aria-label="Choose an assistant">{AGENT_SETUPS.map(setup => <Button className="assistant-choice" data-active={setup.id === selected.id} key={setup.id} type="button" onClick={() => { setSelectedId(setup.id); onSelectionChange?.(setup.id); }} aria-pressed={setup.id === selected.id} aria-controls={instructionId}>
      <span className={`agent-logo ${setup.provider}`}><AgentLogo provider={setup.provider} /></span><span><strong>{setup.id === 'mcp' ? 'Other assistant' : setup.name}</strong><small>{setup.label}</small></span><span className="assistant-choice-check" aria-hidden="true">{setup.id === selected.id ? '✓' : ''}</span>
    </Button>)}</div>
    <div className="assistant-guide" id={instructionId}>
      <div className="assistant-instructions" key={selected.id}>
        <div className="assistant-guide-title"><span className={`agent-logo large ${selected.provider}`}><AgentLogo provider={selected.provider} /></span><h3>{selected.id === 'mcp' ? 'Connect your assistant' : `Connect ${selected.name}`}</h3><a href={selected.docsUrl} target="_blank" rel="noreferrer">Official guide ↗</a></div>
        <ol className="assistant-steps">
          <li><span className="assistant-step-number" aria-hidden="true">1</span><div><h4>{isCommand ? 'Add Adport' : selected.id === 'cursor' ? 'Add Adport to Cursor' : 'Add the Adport connection'}</h4><p>{selected.instructions}</p>
            {selected.open ? <a className="button small" href={selected.open.href} target="_blank" rel="noreferrer">{selected.open.label} ↗</a> : null}
            {selected.id === 'cursor' ? <><a className="button small" href={cursorInstallUrl(baseUrl)}>Add to Cursor ↗</a><Disclosure label="Install manually instead"><p>Add this to ~/.cursor/mcp.json.</p><div className="assistant-code"><pre><code>{command}</code></pre><CopyButton value={command} label="Copy Cursor configuration" /></div></Disclosure></> : <div className={'assistant-code' + (isCommand ? ' is-command' : '')}><span>{isCommand ? 'Terminal' : 'Server URL'}</span><pre><code>{command}</code></pre><CopyButton value={command} label={isCommand ? `Copy ${selected.name} setup` : 'Copy server URL'} /></div>}
          </div></li>
          <li><span className="assistant-step-number" aria-hidden="true">2</span><div><h4>Sign in and choose your project</h4><p>{selected.nextStep}</p><div className="assistant-project"><span>Project to authorize</span><strong>{projectName ?? 'Your current Adport project'}</strong></div>
            {selected.id === 'codex' ? <div className="assistant-code is-command"><pre><code>codex mcp login adport</code></pre><CopyButton value="codex mcp login adport" label="Copy sign-in command" /></div> : null}
          </div></li>
        </ol>
      </div>
      <aside className="assistant-first-answer"><span className="plan-kicker">3 · Get your first answer</span><h3>Put your ad data to work.</h3><p>Open a conversation in {selected.id === 'mcp' ? 'your assistant' : selected.name}, then try one of these.</p>
        <div className="assistant-prompt-options" role="group" aria-label="Choose a first question">{STARTER_PROMPTS.map((item, index) => <Button type="button" key={item.label} aria-pressed={index === promptIndex} onClick={() => setPromptIndex(index)}>{item.label}</Button>)}</div>
        <blockquote>{prompt.text}</blockquote><CopyButton key={promptIndex} value={prompt.text} label="Copy first prompt" />
        <p className="assistant-confirmation">{variant === 'onboarding' || !canCheckConnection ? 'Once connected, your assistant can use the accounts you enabled for this project.' : <>After trying your prompt, <a href="#connected-assistants">refresh connection status</a> to see when Adport was last used.</>}</p>
      </aside>
    </div>
    <div className="assistant-footer"><p>Every ad change starts with a preview for you to approve. Connecting an assistant won’t change your campaigns.</p></div>
  </section>;
}
