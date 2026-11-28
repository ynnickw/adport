'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import type { ToolProvider, ToolSelection } from '@adport/core/tool-catalog';
import { PiPlus } from 'react-icons/pi';
import { Button, Checkbox, Input } from '@/components/controls';
import { Dialog } from '@/components/dialog';
import { InfoTooltip } from '@/components/info-tooltip';
import { ToolCatalogEditor } from '@/components/tool-catalog-editor';
import { ToolCatalogFields } from '@/components/tool-catalog-fields';
import { useToast } from '@/components/toast';
import { formatDate } from '@/components/ui';
import { useConfirm } from '@/components/use-confirm';
import { LEGACY_TOOL_SELECTION, toolSelectionFromForm, type ToolCatalogCountGroup } from '@/lib/mcp-tool-selection';

interface KeySummary {
  id: string;
  name: string;
  keyPrefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  toolSelection?: ToolSelection;
  scopes?: string[];
}

export function ApiKeyManager({ organizationId, suggestedProviders, catalogCounts }: {
  organizationId: string; suggestedProviders: ToolProvider[];
  catalogCounts?: readonly ToolCatalogCountGroup[];
}) {
  const [keys, setKeys] = useState<KeySummary[]>();
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<string>();
  const [loadError, setLoadError] = useState<string>();
  const [revokeError, setRevokeError] = useState<string>();
  const keyListRequest = useRef<AbortController | null>(null);
  const toast = useToast();
  const [confirm, confirmationDialog] = useConfirm();

  const load = useCallback(async () => {
    keyListRequest.current?.abort();
    const controller = new AbortController();
    keyListRequest.current = controller;
    const { signal } = controller;
    setLoadError(undefined);
    try {
      const response = await fetch(`/api/api-keys?organization_id=${organizationId}&view=keys`, { cache: 'no-store', signal });
      const data = await response.json() as { keys?: KeySummary[]; error?: string };
      if (!response.ok) throw new Error(data.error ?? 'Unable to load API keys.');
      if (!signal.aborted) setKeys(data.keys ?? []);
    } catch (error) {
      if (!signal.aborted) setLoadError(error instanceof Error ? error.message : 'Could not load API keys.');
    }
  }, [organizationId]);

  useEffect(() => {
    void load();
    return () => keyListRequest.current?.abort();
  }, [load]);

  async function revoke(id: string) {
    if (revoking || !await confirm({ title: 'Revoke API key?', description: 'Connected agents lose access immediately.', confirmLabel: 'Revoke key' })) return;
    setRevoking(id);
    setRevokeError(undefined);
    try {
      const response = await fetch(`/api/api-keys/${id}?organization_id=${organizationId}`, { method: 'DELETE' });
      if (!response.ok) throw new Error('Unable to revoke API key.');
      toast('API key revoked.');
      await load();
    } catch (error) {
      setRevokeError(error instanceof Error ? error.message : 'Could not revoke the key. Try again.');
    } finally {
      setRevoking(undefined);
    }
  }

  return <section className="settings-section" aria-labelledby="developer-keys">
    <div className="settings-section-head">
      <h2 id="developer-keys">API keys <InfoTooltip label="About API keys">Each key grants access to this project. Revoke a key when its script or integration no longer needs access.</InfoTooltip></h2>
      <Button type="button" className="button" disabled={Boolean(revoking)} onClick={event => {
        event.currentTarget.focus({ preventScroll: true });
        setCreating(true);
      }}><PiPlus aria-hidden="true" /> Create API key</Button>
    </div>
    {confirmationDialog}
    {creating ? <CreateApiKeyDialog organizationId={organizationId} suggestedProviders={suggestedProviders}
      onClose={() => setCreating(false)} onCreated={() => void load()} /> : null}
    {loadError ? <div className="error-callout" role="alert">{loadError} <Button type="button" className="link-button" onClick={() => void load()}>Try again</Button></div> : null}
    {revokeError ? <div className="error-callout" role="alert">{revokeError}</div> : null}
    {!keys && !loadError ? <p className="settings-note" role="status">Loading API keys…</p> : null}
    {keys?.length === 0 ? <p className="settings-note">No API keys for this project.</p> : null}
    {keys?.length ? <ul className="settings-list">{keys.map(key => <li className="settings-row" key={key.id}>
      <div className="settings-row-copy">
        <strong>{key.name}</strong>
        <p className="settings-note"><code>{key.keyPrefix}…</code> · Created {formatDate(key.createdAt)} · {key.lastUsedAt ? `Last used ${formatDate(key.lastUsedAt)}` : 'Never used'}</p>
      </div>
      <div className="settings-row-actions">
        <ToolCatalogEditor organizationId={organizationId} connection={{ type: 'key', id: key.id }}
          initialSelection={key.toolSelection ?? LEGACY_TOOL_SELECTION} catalogCounts={catalogCounts}
          scopes={key.scopes} suggestedProviders={suggestedProviders} onSaved={() => void load()} />
        <Button type="button" className="button danger small" aria-label={`Revoke ${key.name}`} disabled={Boolean(revoking)}
          pending={revoking === key.id} pendingLabel="Revoking…" onClick={() => void revoke(key.id)}>Revoke</Button>
      </div>
    </li>)}</ul> : null}
  </section>;
}

function CreateApiKeyDialog({ organizationId, suggestedProviders, onClose, onCreated }: {
  organizationId: string; suggestedProviders: ToolProvider[]; onClose: () => void; onCreated: () => void;
}) {
  const [createdKey, setCreatedKey] = useState<string>();
  const [revealed, setRevealed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const keyNotice = useRef<HTMLParagraphElement>(null);
  const toast = useToast();

  useEffect(() => {
    if (createdKey) keyNotice.current?.focus();
  }, [createdKey]);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError(undefined);
    try {
      const response = await fetch('/api/api-keys', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          organization_id: organizationId,
          name: String(form.get('name') ?? '').trim() || 'Agent key',
          scopes: form.has('write') ? ['tools:read', 'tools:write'] : ['tools:read'],
          selection: toolSelectionFromForm(form),
        }),
      });
      const data = await response.json().catch(() => ({})) as { key?: string; error?: string };
      if (!response.ok || !data.key) {
        setError(data.error ?? 'Unable to create API key.');
        return;
      }
      setCreatedKey(data.key);
      onCreated();
    } catch {
      setError('Could not create the key. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  }

  async function copyKey() {
    if (!createdKey) return;
    setError(undefined);
    try {
      await navigator.clipboard.writeText(createdKey);
      toast('API key copied.');
    } catch {
      setError('Could not copy the key. Use Show key to copy it manually.');
    }
  }

  return <Dialog title={createdKey ? 'API key created' : 'Create API key'} onClose={() => { if (!busy) onClose(); }}>
    {createdKey ? <div className="stack">
      <p className="settings-note" tabIndex={-1} ref={keyNotice}>Copy this key now. You can only view it here once.</p>
      <Input type={revealed ? 'text' : 'password'} value={createdKey} readOnly aria-label="New API key" autoComplete="off" />
      {error ? <p className="field-error" role="alert">{error}</p> : null}
      <div className="settings-row-actions">
        <Button type="button" className="button secondary" onClick={() => setRevealed(value => !value)}>{revealed ? 'Hide key' : 'Show key'}</Button>
        <Button type="button" className="button" onClick={() => void copyKey()}>Copy key</Button>
        <Button type="button" className="button secondary" onClick={onClose}>Done</Button>
      </div>
    </div> : <form className="form" onSubmit={event => void create(event)} aria-busy={busy}>
      <label className="field">
        <span className="field-label">Key name</span>
        <Input name="name" placeholder="e.g. Reporting script" data-autofocus="fine-pointer" disabled={busy} />
      </label>
      <div className="settings-inline-label">
        <label className="member-project-scope"><Checkbox name="write" disabled={busy} /> Allow ad changes</label>
        <InfoTooltip label="About allowing ad changes">The key can propose changes and apply them after the required preview and approval. Project safeguards still apply.</InfoTooltip>
      </div>
      <ToolCatalogFields initialSelection={{ profile: 'standard', providers: suggestedProviders }} disabled={busy} />
      {error ? <p className="field-error" role="alert">{error}</p> : null}
      <div className="settings-row-actions settings-dialog-actions">
        <Button type="button" className="button secondary" disabled={busy} onClick={onClose}>Cancel</Button>
        <Button type="submit" className="button" pending={busy} pendingLabel="Creating…">Create key</Button>
      </div>
    </form>}
  </Dialog>;
}
