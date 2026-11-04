'use client';

import { useState, type FormEvent } from 'react';
import type { ToolSelection } from '@adport/core/tool-catalog';
import { Button, Disclosure } from './controls';
import { ToolCatalogFields } from './tool-catalog-fields';
import { toolSelectionFromForm, TOOL_PROFILE_OPTIONS } from '@/lib/mcp-tool-selection';

export function ToolCatalogEditor({ organizationId, connection, initialSelection, onSaved }: {
  organizationId: string;
  connection: { type: 'oauth'; client_id: string; user_id: string; resource: string; organization_group_id: string | null } | { type: 'key'; id: string };
  initialSelection: ToolSelection;
  onSaved: () => void;
}) {
  const [savedSelection, setSavedSelection] = useState(initialSelection);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const selection = toolSelectionFromForm(new FormData(event.currentTarget));
    setBusy(true); setError(undefined); setMessage(undefined);
    try {
      const response = await fetch('/api/assistant-connections/catalog', { method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ organization_id: organizationId, connection, selection }) });
      const data = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(data.error ?? 'Could not save tool access.');
      setSavedSelection(selection);
      setMessage('Saved. Refresh tools in your assistant, or reconnect it if the tool list does not update.');
      onSaved();
    } catch (error) { setError(error instanceof Error ? error.message : 'Could not save tool access.'); }
    finally { setBusy(false); }
  }
  const profile = TOOL_PROFILE_OPTIONS.find(option => option.value === savedSelection.profile)!.label;
  return <Disclosure className="assistant-tool-access" label={`Tool access · ${profile} · ${savedSelection.providers === null ? 'All platforms' : `${savedSelection.providers.length} platforms`}`}>
    <form className="stack" onSubmit={event => void save(event)}>
      <ToolCatalogFields initialSelection={savedSelection} disabled={busy} />
      <p className="field-hint">Applies to this connection across its authorized projects. Your account permissions and approval requirements stay the same.</p>
      {error ? <p className="error-callout" role="alert">{error}</p> : null}
      {message ? <p className="field-hint" role="status">{message}</p> : null}
      <div><Button className="button secondary small" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save tool access'}</Button></div>
    </form>
  </Disclosure>;
}
