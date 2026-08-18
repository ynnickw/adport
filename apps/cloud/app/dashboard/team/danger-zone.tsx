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
    const result = await response.json().catch(() => ({})) as { error?: string };
    if (!response.ok) {
      setError(result.error ?? 'Unable to delete organization.');
      setBusy(false);
      return;
    }
    window.location.assign('/');
  }

  return (
    <section className="card danger">
      <div className="card-head"><h2>Delete organization</h2><span className="status critical">Irreversible</span></div>
      <div className="card-body stack">
        <p className="subhead">Revokes OAuth grants where the provider allows it, then deletes this organization&apos;s encrypted credentials, memberships, API keys, pending approvals, and audit events. Apple and Microsoft access must also be removed in those platforms.</p>
        {error ? <div className="error-callout" style={{ marginBottom: 0 }}>{error}</div> : null}
        <div className="form-row">
          <input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} placeholder="Type DELETE to confirm" aria-label="Type DELETE to confirm" style={{ maxWidth: '16rem' }} />
          <button className="button danger" disabled={busy || confirmation !== 'DELETE'} onClick={() => void deleteOrganization()}>{busy ? 'Deleting…' : 'Delete organization'}</button>
        </div>
      </div>
    </section>
  );
}
