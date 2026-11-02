'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AGENT_SETUPS, AgentIdentityLogo, CopyButton, cursorInstallUrl } from '@/app/dashboard/agents/agent-setup-guide';
import type { AssistantConnectionStatus } from '@/lib/cloud/assistant-connection';
import type { AssistantListings } from '@/lib/assistant-listings';
import { Button } from './controls';
import { Dialog } from './dialog';
import { InfoTooltip } from './info-tooltip';
import { AssistantPrompt } from './assistant-prompt';

export function AssistantPicker({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  return <div className="setup-assistant-picker" role="group" aria-label="Choose your AI assistant">{AGENT_SETUPS.map(setup => <Button key={setup.id} type="button" className="setup-assistant-choice" aria-pressed={value === setup.id} onClick={() => onChange(setup.id)}><AgentIdentityLogo name={setup.name} /><span>{setup.id === 'mcp' ? 'Other' : setup.name}</span></Button>)}</div>;
}

const EMPTY_STATUS: AssistantConnectionStatus = { authorized: false, verified: false, hasAccounts: false, clientName: null };

export function AssistantConnect({ baseUrl, projectName, initialAgent = 'chatgpt', listings = {}, onSelectionChange, onStatusChange }: {
  baseUrl: string; projectName: string; initialAgent?: string; listings?: AssistantListings;
  onSelectionChange?: (id: string) => void; onStatusChange?: (status: AssistantConnectionStatus) => void;
}) {
  const [agent, setAgent] = useState(initialAgent);
  const [status, setStatus] = useState(EMPTY_STATUS);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string>();
  const selected = AGENT_SETUPS.find(setup => setup.id === agent) ?? AGENT_SETUPS[0]!;
  const command = selected.command(baseUrl);
  const terminal = selected.id === 'codex' || selected.id === 'claude-code';
  const listing = selected.id === 'chatgpt' || selected.id === 'claude' ? listings[selected.id] : undefined;

  useEffect(() => {
    const controller = new AbortController();
    let pending = false;
    async function check() {
      if (pending || document.hidden) return;
      pending = true; setChecking(true);
      try {
        const response = await fetch('/api/onboarding?' + new URLSearchParams({ agent }), { signal: controller.signal, cache: 'no-store' });
        if (!response.ok) throw new Error();
        const next = await response.json() as AssistantConnectionStatus;
        if (!controller.signal.aborted) { setStatus(next); onStatusChange?.(next); setError(undefined); }
      } catch { if (!controller.signal.aborted) setError('Could not check the connection. Try again.'); }
      finally { pending = false; if (!controller.signal.aborted) setChecking(false); }
    }
    void check();
    const interval = window.setInterval(() => void check(), 5000);
    const focus = () => void check();
    window.addEventListener('focus', focus);
    document.addEventListener('visibilitychange', focus);
    return () => { controller.abort(); window.clearInterval(interval); window.removeEventListener('focus', focus); document.removeEventListener('visibilitychange', focus); };
  }, [agent, onStatusChange]);

  const instructions = <div className="setup-connect-instructions">
    <p>{listing ? `Install Adport from the official ${selected.name} listing, then sign in.` : selected.instructions}</p>
    {listing ? <a className="button" href={listing} target="_blank" rel="noreferrer">Add Adport to {selected.name} ↗</a> : selected.id === 'cursor' ? <a className="button small" href={cursorInstallUrl(baseUrl)}>Add to Cursor ↗</a> : selected.open ? <a className="button small" href={selected.open.href} target="_blank" rel="noreferrer">{selected.open.label} ↗</a> : null}
    {!listing && selected.id !== 'cursor' ? <div className="assistant-code"><span>{terminal ? 'Terminal' : 'Server URL'}</span><pre><code>{command}</code></pre><CopyButton value={command} label={terminal ? 'Copy command' : 'Copy URL'} /></div> : null}
    <p><strong>Sign in to Adport and authorize this project.</strong> <InfoTooltip label="About project authorization">Only accounts enabled in this project are available to the assistant. Authorize the project shown in the toolbar when the sign-in window opens.</InfoTooltip></p>
    {selected.id === 'codex' ? <div className="assistant-code"><pre><code>codex mcp login adport</code></pre><CopyButton value="codex mcp login adport" label="Copy sign-in command" /></div> : <p className="inline-note">{listing ? 'Enable Adport in your conversation after signing in.' : selected.nextStep}</p>}
  </div>;

  return <section className="setup-connect" aria-label="Connect an AI assistant">
    <div className="setup-connect-heading"><h2>AI assistant</h2><div className="setup-connection-status" role="status"><span className={'status ' + (status.verified ? 'success' : 'neutral')}>{status.verified ? 'Read verified' : status.authorized ? 'Waiting for first read' : 'Waiting for sign-in'}</span><InfoTooltip label="About connection verification">Adport checks for a successful account list or nonempty performance report from this assistant in this project. Sign-in alone does not finish setup. Other members’ connections do not count. For an API key or an unrecognized client, choose Other assistant.</InfoTooltip></div></div>
    <AssistantPicker value={agent} onChange={value => { setStatus(EMPTY_STATUS); onStatusChange?.(EMPTY_STATUS); setAgent(value); onSelectionChange?.(value); }} />
    <div className="setup-connect-body">
      {!status.authorized ? instructions : null}
      {status.authorized && !status.verified ? <p className="inline-note">{checking ? 'Checking connection…' : 'Ask your first question below to verify access. Status updates automatically.'}</p> : null}
      {error ? <p className="error-text" role="alert">{error}</p> : null}
      <AssistantPrompt baseUrl={baseUrl} projectName={projectName} assistantName={selected.name} authorized={status.authorized} verified={status.verified} />
      {!status.hasAccounts ? <p className="inline-note"><Link href="/dashboard/accounts">Enable an ad account</Link> to make its data available to your assistant.</p> : null}
      <a className="setup-connect-help" href={selected.docsUrl} target="_blank" rel="noreferrer">Connection guide ↗</a>
    </div>
  </section>;
}

export function ConnectAssistantButton({ baseUrl, projectName, initialAgent, listings, canManage = false }: { baseUrl: string; projectName: string; initialAgent?: string; listings?: AssistantListings; canManage?: boolean }) {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  return <><Button type="button" className="button secondary" onClick={() => setOpen(true)}>Connect assistant</Button>{open ? <Dialog title="Connect your AI assistant" className="connect-assistant-dialog" onClose={() => { setOpen(false); router.refresh(); }}><AssistantConnect baseUrl={baseUrl} projectName={projectName} initialAgent={initialAgent} listings={listings} /><p className="inline-note">Every ad change requires a preview. Connecting won’t change your campaigns.</p>{canManage ? <Link href="/onboarding?resume=1&step=agent" className="link-button">Open project setup</Link> : null}</Dialog> : null}</>;
}
