'use client';

import { useState } from 'react';

export function DangerZone({ organizationId }: { organizationId: string }) {
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function deleteOrganization() {
    if (confirmation !== 'DELETE') return;
    if (!window.confirm('Permanently delete this organization and all Adport Cloud data? This cannot be undone.')) return;
    setBusy(true);
    setError(undefined);
    const response = await fetch('/api/deletion', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ organization_id: organizationId, confirmation }),
    });
    const result = await response.json() as { error?: string };
    if (!response.ok) {
      setError(result.error ?? 'Unable to delete organization.');
      setBusy(false);
      return;
    }
    window.location.assign('/');
  }

  return (
    <section className="card full danger-zone">
      <h2>Delete cloud data</h2>
      <p className="muted">Revokes Google access, deletes this tenant's encrypted credentials, memberships, keys, approvals, and audit events. Revoke manual-provider credentials at those providers separately.</p>
      {error ? <p className="error">{error}</p> : null}
      <div className="actions">
        <label>Type DELETE<input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} /></label>
        <button className="button danger" disabled={busy || confirmation !== 'DELETE'} onClick={() => void deleteOrganization()}>{busy ? 'Deleting…' : 'Delete organization'}</button>
      </div>
    </section>
  );
}
