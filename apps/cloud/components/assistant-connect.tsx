'use client';

import { useEffect, useId, useState, type KeyboardEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AGENT_SETUPS, AgentIdentityLogo, cursorInstallUrl } from '@/app/dashboard/agents/agent-setup-guide';
import { CopyButton } from './copy-button';
import type { AssistantConnectionStatus } from '@/lib/cloud/assistant-connection';
import type { AssistantListings } from '@/lib/assistant-listings';
import { Button } from './controls';
import { Notice } from './feedback';
import { Dialog } from './dialog';
import { AssistantPrompt } from './assistant-prompt';

const EMPTY_STATUS: AssistantConnectionStatus = { authorized: false, verified: false, hasAccounts: false, clientName: null };

export function AssistantConnect({ baseUrl, projectName, initialAgent = 'chatgpt', initialStatus, listings = {}, onSelectionChange, onStatusChange, accountAction, canManageAccounts = true }: {
  baseUrl: string; projectName: string; initialAgent?: string; listings?: AssistantListings;
  initialStatus?: AssistantConnectionStatus;
  onSelectionChange?: (id: string) => void; onStatusChange?: (status: AssistantConnectionStatus) => void;
  accountAction?: React.ReactNode; canManageAccounts?: boolean;
}) {
  const id = useId();
  const [agent, setAgent] = useState(initialAgent);
  const [status, setStatus] = useState(initialStatus ?? EMPTY_STATUS);
  const [checked, setChecked] = useState(Boolean(initialStatus));
  const [error, setError] = useState<string>();
  const selected = AGENT_SETUPS.find(setup => setup.id === agent) ?? AGENT_SETUPS[0]!;
  const command = selected.command(baseUrl);
  const terminal = selected.id === 'codex' || selected.id === 'claude-code';
  const listing = selected.id === 'chatgpt' || selected.id === 'claude' ? listings[selected.id] : undefined;
  const label = selected.id === 'mcp' ? 'your assistant' : selected.name;

  function selectAssistant(next: string) {
    if (next === selected.id) return;
    setError(undefined);
    setChecked(false);
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
      pending = true;
      try {
        const response = await fetch('/api/onboarding?' + new URLSearchParams({ agent }), { signal: controller.signal, cache: 'no-store' });
        if (!response.ok) throw new Error();
        const next = await response.json() as AssistantConnectionStatus;
        if (!controller.signal.aborted) { setStatus(next); setChecked(true); onStatusChange?.(next); setError(undefined); }
      } catch { if (!controller.signal.aborted) setError('Could not check the connection. Try again.'); }
      finally { pending = false; }
    }
    void check();
    const interval = window.setInterval(() => void check(), 5000);
    const focus = () => void check();
    window.addEventListener('focus', focus);
    document.addEventListener('visibilitychange', focus);
    return () => { controller.abort(); window.clearInterval(interval); window.removeEventListener('focus', focus); document.removeEventListener('visibilitychange', focus); };
  }, [agent, onStatusChange]);

  const manualInstruction = selected.id === 'chatgpt' ? 'In Plugins, add a custom MCP server named Adport. Paste the URL and choose OAuth.'
    : selected.id === 'claude' ? 'In Customize → Connectors, add a custom connector named Adport and paste the URL.'
    : selected.id === 'mcp' ? 'Add a remote MCP server named Adport using Streamable HTTP and OAuth.'
    : selected.id === 'claude-code' ? 'Run the command, then open Claude Code and use /mcp to sign in.'
    : selected.id === 'codex' ? 'Run the command and follow the browser sign-in.'
    : 'Open Cursor, confirm Add, then follow the browser sign-in.';
  const statusLabel = status.verified ? 'Read verified'
    : status.authorized || status.existingConnection?.coversProject ? 'Connected' : error ? 'Status unavailable'
    : status.existingConnection ? 'Connected in another project' : checked ? 'Waiting for sign-in' : 'Checking connection…';

  return <section className="setup-connect" aria-label="Connect an AI assistant">
    <div className="setup-assistant-picker-block">
      <p className="assistant-section-label" id={`${id}-choice`}>Choose your assistant</p>
      <div className="setup-assistant-tabs" role="tablist" aria-labelledby={`${id}-choice`} onKeyDown={navigateTabs}>
        {AGENT_SETUPS.map(setup => <Button key={setup.id} id={`${id}-tab-${setup.id}`} type="button" role="tab" aria-selected={selected.id === setup.id} aria-controls={`${id}-panel`} tabIndex={selected.id === setup.id ? 0 : -1} onClick={() => selectAssistant(setup.id)}><AgentIdentityLogo name={setup.name} /><span>{setup.id === 'mcp' ? 'Other MCP client' : setup.name}</span></Button>)}
      </div>
    </div>
    <div className="setup-connect-body" id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-tab-${selected.id}`} tabIndex={0}>
      {!status.authorized ? <div className="setup-connect-instructions">
        {status.existingConnection ? <p className="assistant-existing-connection"><strong>{status.existingConnection.clientName} is already connected</strong>
          {status.existingConnection.coversProject ? ' for this project.' : ' in another project. Include this project when you authorize to use it here.'}</p> : null}
        <h3>Connect {label}</h3>
        <p>{listing ? `Add Adport in ${selected.name}, then sign in and choose which workspaces to share.` : manualInstruction}</p>
        {listing ? <a className="button" href={listing} target="_blank" rel="noreferrer" aria-label={`Add Adport from the official ${selected.name} connector`}>Add to {selected.name} ↗</a>
          : selected.id === 'cursor' ? <a className="button" href={cursorInstallUrl(baseUrl)}>Add to Cursor ↗</a>
          : <><div className="assistant-code"><span>{terminal ? 'Terminal' : 'Server URL'}</span><pre><code>{command}</code></pre><CopyButton key={selected.id} value={command} label={terminal ? 'Copy command' : 'Copy URL'} /></div>
            {selected.open ? <a className="button" href={selected.open.href} target="_blank" rel="noreferrer">{selected.open.label} ↗</a> : null}</>}
        {!listing && selected.id === 'codex' ? <div className="assistant-login-fallback"><p>Sign-in didn’t open? Run <code>codex mcp login adport</code>.</p><CopyButton value="codex mcp login adport" label="Copy sign-in command" /></div> : null}
        {!listing ? <p className="inline-note">Authorize <strong>{projectName}</strong> or its organization.{selected.id === 'mcp' ? <> Your admin can provide an API key for clients that require one.</> : null}</p> : null}
      </div> : status.hasAccounts ? <AssistantPrompt projectName={projectName} verified={status.verified} /> : <div className="setup-connect-instructions">
        <h3>Enable account access</h3>
        <p>{canManageAccounts ? 'Enable an account whenever you’re ready to give your assistant data to work with.' : 'Ask a project owner or admin to enable an account for this project.'}</p>
        {canManageAccounts ? accountAction ?? <Link className="button secondary" href="/dashboard/accounts">Add accounts</Link> : null}
      </div>}
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div className="setup-connect-footer">
        <span className={`status ${status.verified ? 'success' : 'neutral'}`} role="status">{statusLabel}</span>
        <a className="setup-connect-help" href={selected.docsUrl} target="_blank" rel="noreferrer">Connection guide ↗</a>
      </div>
    </div>
  </section>;
}

export function ConnectAssistantButton({ baseUrl, projectName, initialAgent, listings, canManageAccounts }: {
  baseUrl: string; projectName: string; initialAgent?: string; listings?: AssistantListings; canManageAccounts: boolean;
}) {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  return <><Button type="button" className="button" onClick={() => setOpen(true)}>Connect assistant</Button>{open ? <Dialog title="Connect an assistant" className="connect-assistant-dialog" onClose={() => { setOpen(false); router.refresh(); }}><AssistantConnect baseUrl={baseUrl} projectName={projectName} initialAgent={initialAgent} listings={listings} canManageAccounts={canManageAccounts} /></Dialog> : null}</>;
}
