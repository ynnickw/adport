'use client';

import { useEffect, useId, useState, type KeyboardEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AGENT_SETUPS, AgentIdentityLogo, CopyButton, cursorInstallUrl } from '@/app/dashboard/agents/agent-setup-guide';
import type { AssistantConnectionStatus } from '@/lib/cloud/assistant-connection';
import type { AssistantListings } from '@/lib/assistant-listings';
import { Button, Disclosure } from './controls';
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
  const id = useId();
  const selected = AGENT_SETUPS.find(setup => setup.id === agent) ?? AGENT_SETUPS[0]!;
  const command = selected.command(baseUrl);
  const terminal = selected.id === 'codex' || selected.id === 'claude-code';
  const listing = selected.id === 'chatgpt' || selected.id === 'claude' ? listings[selected.id] : undefined;

  function selectAssistant(next: string) {
    if (next === selected.id) return;
    setStatus(EMPTY_STATUS);
    onStatusChange?.(EMPTY_STATUS);
    setAgent(next);
    onSelectionChange?.(next);
  }
  function navigateTabs(event: KeyboardEvent<HTMLDivElement>) {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const tabs = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    const index = tabs.indexOf(event.target as HTMLButtonElement);
    if (index < 0) return;
    const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length
      : event.key === 'ArrowLeft' ? (index - 1 + tabs.length) % tabs.length
      : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : -1;
    if (next < 0) return;
    event.preventDefault();
    selectAssistant(AGENT_SETUPS[next]!.id);
    tabs[next]?.focus();
    tabs[next]?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

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
    {!listing && (selected.id === 'cursor' ? <a className="button small" href={cursorInstallUrl(baseUrl)}>Add to Cursor ↗</a> : selected.open ? <a className="button small" href={selected.open.href} target="_blank" rel="noreferrer">{selected.open.label} ↗</a> : null)}
    {!listing && selected.id !== 'cursor' ? <div className="assistant-code"><span>{terminal ? 'Terminal' : 'Server URL'}</span><pre><code>{command}</code></pre><CopyButton value={command} label={terminal ? 'Copy command' : 'Copy URL'} /></div> : null}
    <p><strong>Sign in to Adport and choose {projectName}.</strong> <InfoTooltip label="About project authorization">Only accounts enabled in this project are available to the assistant. Authorize this same project when the sign-in window opens.</InfoTooltip></p>
    {selected.id === 'codex' ? <div className="assistant-code"><pre><code>codex mcp login adport</code></pre><CopyButton value="codex mcp login adport" label="Copy sign-in command" /></div> : <p className="inline-note">{listing ? 'Enable Adport in your conversation after signing in.' : selected.nextStep}</p>}
    {listing ? <Disclosure label="Set up manually"><p>{selected.instructions}</p><div className="assistant-code"><pre><code>{command}</code></pre><CopyButton value={command} label="Copy server URL" /></div></Disclosure> : null}
  </div>;

  return <section className="card setup-connect" aria-label="Connect an AI assistant">
    <div className="setup-assistant-tabs" role="tablist" aria-label="Choose your AI assistant" onKeyDown={navigateTabs}>
      {AGENT_SETUPS.map(setup => <Button key={setup.id} id={`${id}-tab-${setup.id}`} type="button" role="tab" aria-selected={selected.id === setup.id} aria-controls={`${id}-panel`} tabIndex={selected.id === setup.id ? 0 : -1} onClick={() => selectAssistant(setup.id)}><AgentIdentityLogo name={setup.name} /><span>{setup.id === 'mcp' ? 'Other' : setup.name}</span></Button>)}
    </div>
    <div id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-tab-${selected.id}`} tabIndex={0}>
      <div className="card-head"><h2>{selected.id === 'mcp' ? 'Connect your assistant' : `Connect ${selected.name}`}</h2>{listing ? <a className="button secondary small setup-listing-button" href={listing} target="_blank" rel="noreferrer" aria-label={`Add Adport from the official ${selected.name} connector`}><AgentIdentityLogo name={selected.name} />Add to {selected.name} <span aria-hidden="true">↗</span></a> : null}</div>
      <div className="card-body stack">
        <p className="setup-project-scope">Project · <strong>{projectName}</strong></p>
        {status.authorized ? <Disclosure label="Connection instructions">{instructions}</Disclosure> : instructions}
        <div className="setup-connection-status" role="status"><span className={'status ' + (status.verified ? 'success' : 'neutral')}>{status.verified ? 'Read verified' : status.authorized ? 'Authorized · waiting for a read' : 'Waiting for sign-in'}</span><InfoTooltip label="About connection verification">Adport checks for a successful account list or nonempty performance report from this assistant in this project. Sign-in alone does not finish setup. Other members’ connections do not count. For an API key or an unrecognized client, choose Other assistant.</InfoTooltip>{status.authorized && status.clientName ? <small>{status.clientName}</small> : null}</div>
        {status.verified ? <p className="inline-note">Your assistant successfully read this project’s ad data.{!status.hasAccounts ? ' Enable an account to finish setup.' : ' You’re ready to go.'}</p> : !status.authorized ? <p className="inline-note">After sign-in, come back here for your first question. Status updates automatically.</p> : <p className="inline-note">{checking ? 'Checking…' : 'Status updates automatically after a successful read.'}</p>}
        {error ? <p className="error-text" role="alert">{error}</p> : null}
        <AssistantPrompt baseUrl={baseUrl} projectName={projectName} assistantName={selected.name} authorized={status.authorized} verified={status.verified} />
        {!status.hasAccounts ? <p className="inline-note"><Link href="/dashboard/accounts">Enable an ad account</Link> to make its data available to your assistant.</p> : null}
      </div>
    </div>
  </section>;
}

export function ConnectAssistantButton({ baseUrl, projectName, initialAgent, listings, canManage = false }: { baseUrl: string; projectName: string; initialAgent?: string; listings?: AssistantListings; canManage?: boolean }) {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  return <><Button type="button" className="button secondary" onClick={() => setOpen(true)}>Connect assistant</Button>{open ? <Dialog title="Connect your AI assistant" className="connect-assistant-dialog" onClose={() => { setOpen(false); router.refresh(); }}><AssistantConnect baseUrl={baseUrl} projectName={projectName} initialAgent={initialAgent} listings={listings} /><p className="inline-note">Every ad change requires a preview. Connecting won’t change your campaigns.</p>{canManage ? <Link href="/onboarding?resume=1&step=agent" className="link-button">Open project setup</Link> : null}</Dialog> : null}</>;
}
