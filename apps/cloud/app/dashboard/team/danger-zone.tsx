'use client';

import { Button, Input } from '@/components/controls';
import { Dialog } from '@/components/dialog';
import { useState } from 'react';

export function DangerZone({ organizationId, isDefaultProject = true }: { organizationId: string; isDefaultProject?: boolean }) {
  const subject = isDefaultProject ? 'organization' : 'project';
  const [open, setOpen] = useState(false);
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  function close() {
    if (busy) return;
    setOpen(false);
    setConfirmation('');
    setError(undefined);
  }

  async function deleteOrganization() {
    if (confirmation !== 'DELETE' || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const response = await fetch('/api/deletion', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ organization_id: organizationId, confirmation }),
      });
      const result = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(result.error ?? `Unable to delete this ${subject}.`);
      window.location.assign('/');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : `Unable to delete this ${subject}.`);
      setBusy(false);
    }
  }

  return (
    <div className="settings-row project-settings-row">
      <div className="settings-row-copy">
        <h3>Delete {subject}</h3>
        <p className="settings-note">Permanently delete this {subject} and its Adport data.</p>
      </div>
      <Button type="button" className="button danger small" onClick={event => {
        event.currentTarget.focus({ preventScroll: true });
        setOpen(true);
      }}>Delete {subject}</Button>
      {open ? <Dialog title={`Delete ${subject}?`} onClose={close} portal>
        <div className="stack">
          <p className="settings-note">This permanently deletes the {subject}’s credentials, memberships, API keys, pending approvals, and audit history. Adport revokes Google access before deletion. Remove other grants in their respective platforms. {isDefaultProject ? 'Remove the other projects before deleting this organization.' : null}</p>
          <label className="field">
            <span className="field-label">Type DELETE to confirm</span>
            <Input value={confirmation} onChange={event => setConfirmation(event.target.value)} disabled={busy} autoComplete="off" />
          </label>
          {error ? <p className="field-error" role="alert">{error}</p> : null}
          <div className="settings-row-actions settings-dialog-actions">
            <Button type="button" className="button secondary" disabled={busy} onClick={close}>Cancel</Button>
            <Button type="button" className="button danger" disabled={confirmation !== 'DELETE'} pending={busy}
              pendingLabel="Deleting…" onClick={() => void deleteOrganization()}>Permanently delete {subject}</Button>
          </div>
        </div>
      </Dialog> : null}
    </div>
  );
}
