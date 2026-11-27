'use client';

import { useEffect, useState, type FormEvent } from 'react';
import type { ToolSelection } from '@adport/core/tool-catalog';
import { Button } from './controls';
import { Dialog } from './dialog';
import { ToolCatalogFields } from './tool-catalog-fields';
import { useToast } from './toast';
import { toolSelectionFromForm, TOOL_PROFILE_OPTIONS } from '@/lib/mcp-tool-selection';

export function toolAccessSummary(selection: ToolSelection) {
  const profile = TOOL_PROFILE_OPTIONS.find(option => option.value === selection.profile)!.label;
  const count = selection.providers?.length;
  return `${profile} · ${count === undefined ? 'All platforms' : count === 0 ? 'No platforms' : count === 1 ? '1 platform' : `${count} platforms`}`;
}

function selectionKey(selection: ToolSelection) {
  return JSON.stringify([selection.profile, selection.providers === null ? null : [...selection.providers].sort()]);
}

export function ToolCatalogEditor({ organizationId, connection, initialSelection, onSaved, name, openOnLoad }: {
  organizationId: string;
  connection: { type: 'oauth'; client_id: string; user_id: string; resource: string; organization_group_id: string | null } | { type: 'key'; id: string };
  initialSelection: ToolSelection;
  onSaved: () => void;
  name?: string;
  openOnLoad?: boolean;
}) {
  const baseline = selectionKey(initialSelection);
  const [saved, setSaved] = useState<{ baseline: string; selection: ToolSelection }>();
  const savedSelection = saved?.baseline === baseline ? saved.selection : initialSelection;
  const [open, setOpen] = useState(Boolean(openOnLoad));
  const [draft, setDraft] = useState<ToolSelection>();
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const [error, setError] = useState<string>();
  const connectionId = connection.type === 'key' ? connection.id : connection.client_id;
  const dirty = draft !== undefined && selectionKey(draft) !== selectionKey(savedSelection);
  useEffect(() => {
    if (openOnLoad) { setOpen(true); return; }
    if (connection.type !== 'key') return;
    const query = new URLSearchParams(window.location.search);
    if (query.get('connection') === connectionId && query.get('kind') === 'key') setOpen(true);
  }, [connectionId, connection.type, openOnLoad]);
  function close() {
    setOpen(false); setDraft(undefined); setError(undefined);
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!dirty || busy) return;
    try {
      const selection = toolSelectionFromForm(new FormData(event.currentTarget));
      setBusy(true); setError(undefined);
      const response = await fetch('/api/assistant-connections/catalog', { method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ organization_id: organizationId, connection, selection }) });
      const data = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(data.error ?? 'Could not save tool access.');
      setSaved({ baseline, selection });
      close();
      toast('Tool access saved. Refresh tools in your assistant.');
      onSaved();
    } catch (error) { setError(error instanceof Error ? error.message : 'Could not save tool access.'); }
    finally { setBusy(false); }
  }
  return <>
    <Button type="button" className="button secondary small" aria-label={name ? `Manage access for ${name}` : undefined}
      onClick={() => setOpen(true)}>{name ? 'Manage access' : `Tool access · ${toolAccessSummary(savedSelection)}`}</Button>
    {open ? <Dialog title={name ? `${name} access` : 'API key tool access'} className="assistant-access-dialog" onClose={() => { if (!busy) close(); }}>
      <form className="assistant-access-form" onSubmit={event => void save(event)}>
        <div className="assistant-access-scroll">
          <ToolCatalogFields initialSelection={savedSelection} disabled={busy} manage onSelectionChange={setDraft} />
        </div>
        <div className="assistant-access-footer">
          <p className="assistant-access-note">{connection.type === 'oauth' && connection.organization_group_id ? 'Applies to all projects on this connection. ' : ''}Account permissions and approval rules still apply.</p>
          {error ? <p className="error-callout" role="alert">{error}</p> : null}
          <div className="assistant-access-actions">
            <Button className="button secondary" type="button" disabled={busy} onClick={close}>Cancel</Button>
            <Button className="button" type="submit" disabled={!dirty || busy} pending={busy} pendingLabel="Saving…">Save tool access</Button>
          </div>
        </div>
      </form>
    </Dialog> : null}
  </>;
}
