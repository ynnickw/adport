'use client';

import { Button, Disclosure, Input } from '@/components/controls';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { formatDate, formatRelative } from '@/components/ui';
import { InfoTooltip } from '@/components/info-tooltip';
import { useConfirm } from '@/components/use-confirm';
import { AgentIdentityLogo } from './agent-setup-guide';
import type { ToolProvider, ToolSelection } from '@adport/core/tool-catalog';
import { ToolCatalogFields } from '@/components/tool-catalog-fields';
import { ToolCatalogEditor } from '@/components/tool-catalog-editor';
import { LEGACY_TOOL_SELECTION, toolSelectionFromForm } from '@/lib/mcp-tool-selection';

interface KeySummary { id: string; name: string; keyPrefix: string; createdAt: string; lastUsedAt: string | null; toolSelection?: ToolSelection; }
export interface OAuthGrantSummary {
  toolSelection?: ToolSelection;
  organizationGroupId?: string | null;
  clientId: string;
  userId: string;
  clientName: string;
  clientUri: string | null;
  scopes: string[];
  resource: string;
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
  status: 'active' | 'rotated' | 'revoked' | 'expired';
}

function AssistantConnection({ grant, checkedAt, organizationId, currentUserId, onSaved }: { grant: OAuthGrantSummary; checkedAt: number; organizationId: string; currentUserId?: string; onSaved: () => void }) {
  return <div className="row-item assistant-connection">
    <AgentIdentityLogo name={grant.clientName} clientUri={grant.clientUri} /><div className="assistant-connection-details">
      <div className="agent-identity"><strong>{grant.clientName}</strong><span className={'status' + (grant.status === 'active' && grant.lastUsedAt ? '' : ' neutral')}>{grant.status === 'active' ? grant.lastUsedAt ? 'In use' : 'Authorized' : grant.status === 'revoked' ? 'Disconnected' : 'Sign in again'}</span><InfoTooltip label={`Connection details for ${grant.clientName}`}>Access: {grant.scopes.includes('tools:write') ? 'Read and propose changes' : 'Read only'}. Authorized {formatDate(grant.createdAt)}. Sign-in expires {formatDate(grant.expiresAt)}.</InfoTooltip></div>
      <p className="cell-sub">{grant.organizationGroupId ? 'All accessible projects · ' : ''}{grant.status === 'active' ? grant.lastUsedAt ? `Last reached Adport ${formatRelative(grant.lastUsedAt, checkedAt)}` : 'Authorized, waiting for its first request.' : 'Reconnect from your assistant to authorize access again.'}</p>
      {grant.status === 'active' && grant.userId === currentUserId ? <ToolCatalogEditor organizationId={organizationId}
        connection={{ type: 'oauth', client_id: grant.clientId, user_id: grant.userId, resource: grant.resource, organization_group_id: grant.organizationGroupId ?? null }}
        initialSelection={grant.toolSelection ?? LEGACY_TOOL_SELECTION} onSaved={onSaved} /> : null}
    </div>
  </div>;
}

export function ApiKeyManager({ organizationId, currentUserId, suggestedProviders, canManage, baseUrl, initialGrants, initialCheckedAt, setup }: { organizationId: string; currentUserId?: string; suggestedProviders?: ToolProvider[]; canManage: boolean; baseUrl: string; initialGrants: OAuthGrantSummary[]; initialCheckedAt: number; setup: ReactNode }) {
  const [checking, setChecking] = useState(false);
  const [checkedAt, setCheckedAt] = useState(initialCheckedAt);
  const [keys, setKeys] = useState<KeySummary[]>();
  const [oauthGrants, setOauthGrants] = useState<OAuthGrantSummary[]>(initialGrants);
  const [createdKey, setCreatedKey] = useState<string>();
  const [name, setName] = useState('');
  const [error, setError] = useState<string>();
  const [connectionError, setConnectionError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [busyAction, setBusyAction] = useState<string>();
  const [copied, setCopied] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [confirm, confirmationDialog] = useConfirm();
  const advanced = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('kind') === 'key' && advanced.current) advanced.current.open = true;
  }, []);

  const load = useCallback(async () => {
    setChecking(true); setConnectionError(undefined);
    try {
      const response = await fetch(`/api/api-keys?organization_id=${organizationId}`, { cache: 'no-store' });
      const data = await response.json().catch(() => ({})) as { keys?: KeySummary[]; oauthGrants?: OAuthGrantSummary[]; error?: string };
      if (!response.ok) setConnectionError(data.error ?? 'Unable to load assistant connections.');
      else {
        setKeys(data.keys ?? []);
        setOauthGrants(data.oauthGrants ?? []);
        setCheckedAt(Date.now());
      }
    } catch { setConnectionError('Could not load assistant connections. Check your connection and try again.'); }
    finally { setChecking(false); }
  }, [organizationId]);

  useEffect(() => {
    const refresh = () => { void load(); };
    refresh();
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, [load]);

  async function create(selection: ToolSelection) {
    setBusy(true);
    setBusyAction('create'); setCopied(false); setRevealed(false);
    setError(undefined);
    try {
      const response = await fetch('/api/api-keys', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ organization_id: organizationId, name: name.trim() || 'Agent key', scopes: ['tools:read', 'tools:write'], selection }),
      });
      const data = await response.json().catch(() => ({})) as { key?: string; error?: string };
      if (!response.ok || !data.key) setError(data.error ?? 'Unable to create API key.');
      else { setCreatedKey(data.key); setName(''); await load(); }
    } catch {
      setError('Could not create the key. Check your connection and try again.');
    } finally {
      setBusy(false);
      setBusyAction(undefined);
    }
  }

  async function revoke(id: string) {
    if (!await confirm({ title: 'Revoke API key?', description: 'Connected agents lose access immediately.', confirmLabel: 'Revoke key' })) return;
    setBusy(true); setBusyAction(id); setError(undefined);
    try {
      const response = await fetch(`/api/api-keys/${id}?organization_id=${organizationId}`, { method: 'DELETE' });
      if (!response.ok) setError('Unable to revoke API key.');
      else await load();
    } catch { setError('Could not revoke the key. Check your connection and try again.'); }
    finally { setBusy(false); setBusyAction(undefined); }
  }

  async function copyKey() {
    if (!createdKey) return;
    try { await navigator.clipboard.writeText(createdKey); setCopied(true); }
    catch { setError('Could not copy the key. Use Show key to copy it manually.'); }
  }

  const activeGrants = oauthGrants.filter(grant => grant.status === 'active').sort((a, b) =>
    Number(Boolean(b.lastUsedAt)) - Number(Boolean(a.lastUsedAt)) || Date.parse(b.lastUsedAt ?? b.createdAt) - Date.parse(a.lastUsedAt ?? a.createdAt));
  const previousGrants = oauthGrants.filter(grant => grant.status !== 'active').sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const connectionRows = (grants: OAuthGrantSummary[]) => grants.map(grant => <AssistantConnection key={`${grant.clientId}:${grant.userId}:${grant.resource}:${grant.organizationGroupId ?? 'project'}`} grant={grant} checkedAt={checkedAt} organizationId={organizationId} currentUserId={currentUserId} onSaved={() => void load()} />);

  const connectionPanel = (
    <section className="card assistant-connections" id="connected-assistants" aria-label="Connected assistants">
      <div className="card-head"><div><h2>Connected assistants</h2><p className="card-kicker">Connections authorized for this project.</p></div><Button type="button" className="button secondary small" disabled={checking || busy} onClick={() => void load()}>{checking ? 'Checking…' : 'Refresh status'}</Button></div>
      {connectionError ? <div className="card-body"><div className="error-callout" role="alert">{connectionError}</div></div> : null}
      <div className="row-list">
        {!activeGrants.length ? <div className="assistant-connections-empty"><strong>{oauthGrants.length ? 'No active assistant connections' : 'No assistant connected yet'}</strong><p>{oauthGrants.length ? 'Reconnect from your assistant, or follow the setup above to connect again.' : 'Follow the setup above, then refresh here. Your assistant appears after you sign in and authorize Adport.'}</p></div> : null}
        {connectionRows(activeGrants.slice(0, 3))}
      </div>
      {activeGrants.length > 3 ? <Disclosure className="assistant-connection-group" label={`More current connections (${activeGrants.length - 3})`}>
        <div className="row-list">{connectionRows(activeGrants.slice(3))}</div>
      </Disclosure> : null}
      {previousGrants.length ? <Disclosure className="assistant-connection-group" label={`Previous connections (${previousGrants.length})`}>
        <p className="assistant-history-note">Expired, replaced, or disconnected sign-ins.</p>
        <div className="row-list">{connectionRows(previousGrants)}</div>
      </Disclosure> : null}
      <p className="assistant-checked" role="status">Last checked {formatDate(new Date(checkedAt))}. Refreshes when you return to this tab.</p>
    </section>
  );

  return <>
    {confirmationDialog}
    {initialGrants.some(grant => grant.status === 'active') ? connectionPanel : null}
    {setup}
    {!initialGrants.some(grant => grant.status === 'active') ? connectionPanel : null}
    {canManage ? <Disclosure ref={advanced} label="Advanced: API keys & custom integrations" className="assistant-advanced">
      <p>For scripts or clients that cannot sign in with OAuth. ChatGPT, Codex, Claude, and Cursor use the setup above.</p>
      {error ? <div className="error-callout" role="alert">{error}</div> : null}
      {createdKey ? <div className="stack">
        <div className="callout success" role="status">Copy this key now. It is shown only once.</div>
        <Input type={revealed ? 'text' : 'password'} value={createdKey} readOnly aria-label="New API key" autoComplete="off" />
        <div className="row-actions secret-key-actions"><Button type="button" className="button secondary small" onClick={() => void copyKey()}>{copied ? 'Copied' : 'Copy key'}</Button><Button type="button" className="link-button" onClick={() => setRevealed(value => !value)}>{revealed ? 'Hide key' : 'Show key'}</Button><Button type="button" className="link-button" onClick={() => { setCreatedKey(undefined); setCopied(false); setRevealed(false); }}>Done</Button></div>
      </div> : null}
      <div className="row-list">{keys?.map(key => <div className="row-item" key={key.id}><div className="assistant-connection-details"><strong>{key.name}</strong><div className="cell-sub">{key.keyPrefix}… · created {formatDate(key.createdAt)} · {key.lastUsedAt ? `last used ${formatDate(key.lastUsedAt)}` : 'never used'}</div><ToolCatalogEditor organizationId={organizationId} connection={{ type: 'key', id: key.id }} initialSelection={key.toolSelection ?? LEGACY_TOOL_SELECTION} onSaved={() => void load()} /></div><Button className="button danger small" disabled={busy} onClick={() => void revoke(key.id)}>{busyAction === key.id ? 'Revoking…' : 'Revoke'}</Button></div>)}</div>
      <form className="stack" onSubmit={event => { event.preventDefault(); void create(toolSelectionFromForm(new FormData(event.currentTarget))); }}>
        <Input value={name} onChange={event => setName(event.target.value)} placeholder="Key name, e.g. Reporting script" aria-label="Key name" />
        <ToolCatalogFields initialSelection={{ profile: 'standard', providers: suggestedProviders ?? null }} disabled={busy} />
        <div><Button type="submit" className="button secondary" disabled={busy}>{busyAction === 'create' ? 'Creating…' : 'Create key'}</Button></div>
      </form>
      <p className="inline-note">Use the key as a bearer token. Changes require a preview and your approval.</p>
      <div className="assistant-reference"><div><span>MCP server</span><code>{baseUrl}/mcp</code></div><div><span>REST accounts</span><code>GET {baseUrl}/api/v1/accounts</code></div><div><span>REST tools</span><code>POST {baseUrl}/api/v1/tools/&lt;tool&gt;</code></div></div>
    </Disclosure> : null}
  </>;
}
