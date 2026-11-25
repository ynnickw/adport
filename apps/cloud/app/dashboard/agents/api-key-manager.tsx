'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button, Checkbox, Disclosure, Input } from '@/components/controls';
import { formatDate } from '@/components/ui';
import { useConfirm } from '@/components/use-confirm';
import { CopyButton } from './agent-setup-guide';
import { adportToolSearchConfig } from '@/lib/mcp-tool-search-config';
import type { ToolProvider, ToolSelection } from '@adport/core/tool-catalog';
import { ToolCatalogFields } from '@/components/tool-catalog-fields';
import { ToolCatalogEditor } from '@/components/tool-catalog-editor';
import { LEGACY_TOOL_SELECTION, toolSelectionFromForm } from '@/lib/mcp-tool-selection';

interface KeySummary { id: string; name: string; keyPrefix: string; createdAt: string; lastUsedAt: string | null; toolSelection?: ToolSelection; }

export function ApiKeyManager({ organizationId, suggestedProviders, baseUrl }: { organizationId: string; suggestedProviders: ToolProvider[]; baseUrl: string }) {
  const [keys, setKeys] = useState<KeySummary[]>();
  const [createdKey, setCreatedKey] = useState<string>();
  const [name, setName] = useState('');
  const [write, setWrite] = useState(false);
  const [error, setError] = useState<string>();
  const [loadError, setLoadError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [busyAction, setBusyAction] = useState<string>();
  const [copied, setCopied] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [confirm, confirmationDialog] = useConfirm();

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoadError(undefined);
    try {
      const response = await fetch(`/api/api-keys?organization_id=${organizationId}&view=keys`, { cache: 'no-store', signal });
      const data = await response.json() as { keys?: KeySummary[]; error?: string };
      if (!response.ok) throw new Error(data.error ?? 'Unable to load API keys.');
      if (!signal?.aborted) setKeys(data.keys ?? []);
    } catch (error) {
      if (!signal?.aborted) setLoadError(error instanceof Error ? error.message : 'Could not load API keys.');
    }
  }, [organizationId]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  async function create(selection: ToolSelection) {
    setBusy(true);
    setBusyAction('create'); setCopied(false); setRevealed(false);
    setError(undefined);
    try {
      const response = await fetch('/api/api-keys', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ organization_id: organizationId, name: name.trim() || 'Agent key', scopes: write ? ['tools:read', 'tools:write'] : ['tools:read'], selection }),
      });
      const data = await response.json().catch(() => ({})) as { key?: string; error?: string };
      if (!response.ok || !data.key) setError(data.error ?? 'Unable to create API key.');
      else { setCreatedKey(data.key); setName(''); setWrite(false); await load(); }
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

  return <section className="card developer-keys" aria-label="API keys">
    <div className="card-head"><h2>API keys</h2></div>
    <div className="card-body stack">
      {confirmationDialog}
      {loadError ? <div className="error-callout" role="alert">{loadError} <Button className="link-button" onClick={() => void load()}>Try again</Button></div> : !keys ? <p className="inline-note" role="status">Loading keys…</p> : null}
      {error ? <div className="error-callout" role="alert">{error}</div> : null}
      {createdKey ? <div className="stack">
        <div className="callout success" role="status">Copy this key now. It is shown only once.</div>
        <Input type={revealed ? 'text' : 'password'} value={createdKey} readOnly aria-label="New API key" autoComplete="off" />
        <div className="row-actions secret-key-actions"><Button type="button" className="button secondary small" onClick={() => void copyKey()}>{copied ? 'Copied' : 'Copy key'}</Button><Button type="button" className="link-button" onClick={() => setRevealed(value => !value)}>{revealed ? 'Hide key' : 'Show key'}</Button><Button type="button" className="link-button" onClick={() => { setCreatedKey(undefined); setCopied(false); setRevealed(false); }}>Done</Button></div>
      </div> : null}
      {keys?.length === 0 ? <p className="inline-note">No API keys for this project.</p> : null}
      <div className="row-list">{keys?.map(key => <div className="row-item" key={key.id}><div className="assistant-connection-details"><strong>{key.name}</strong><div className="cell-sub">{key.keyPrefix}… · created {formatDate(key.createdAt)} · {key.lastUsedAt ? `last used ${formatDate(key.lastUsedAt)}` : 'never used'}</div><ToolCatalogEditor organizationId={organizationId} connection={{ type: 'key', id: key.id }} initialSelection={key.toolSelection ?? LEGACY_TOOL_SELECTION} onSaved={() => void load()} /></div><Button className="button danger small" disabled={busy} pending={busyAction === key.id} pendingLabel="Revoking…" onClick={() => void revoke(key.id)}>Revoke</Button></div>)}</div>
      <Disclosure label="Create API key" className="developer-create">
      <form className="stack" onSubmit={event => { event.preventDefault(); void create(toolSelectionFromForm(new FormData(event.currentTarget))); }}>
        <Input value={name} onChange={event => setName(event.target.value)} placeholder="Key name, e.g. Reporting script" aria-label="Key name" />
        <label className="member-project-scope"><Checkbox checked={write} disabled={busy} onChange={event => setWrite(event.target.checked)} /> Allow changes after approval</label>
        <ToolCatalogFields initialSelection={{ profile: 'standard', providers: suggestedProviders }} disabled={busy} />
        <div><Button type="submit" className="button secondary" disabled={busy} pending={busyAction === 'create'} pendingLabel="Creating…">Create key</Button></div>
      </form>
      </Disclosure>
      <Disclosure label="Tool search for OpenAI and Claude APIs">
        <p>Keep Standard for everyday tasks. For specialist workflows, choose Full for this key and use tool search to load definitions on demand.</p>
        <p>Copy the fields into your model API request. Replace <code>YOUR_ADPORT_API_KEY</code> in your application’s server-side code.</p>
        {adportToolSearchConfig(baseUrl).map(({ name, docsUrl, header, config }) => <div className="stack" key={name}>
          <h3><a href={docsUrl} target="_blank" rel="noreferrer">{name}</a></h3>
          {header ? <p>Send the header <code>{header}</code>.</p> : null}
          <div className="assistant-code"><pre><code>{config}</code></pre><CopyButton value={config} label={`Copy ${name} tool search config`} /></div>
        </div>)}
      </Disclosure>
      <div className="assistant-reference"><div><span>MCP server</span><code>{baseUrl}/mcp</code></div><div><span>REST accounts</span><code>GET {baseUrl}/api/v1/accounts</code></div><div><span>REST tools</span><code>POST {baseUrl}/api/v1/tools/&lt;tool&gt;</code></div></div>
    </div>
  </section>;
}
