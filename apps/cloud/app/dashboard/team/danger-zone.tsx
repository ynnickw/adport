'use client';

import { useState } from 'react';

export function DangerZone({ organizationId, isDefaultProject = true }: { organizationId: string; isDefaultProject?: boolean }) {
  const subject = isDefaultProject ? 'organization' : 'project';
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function deleteOrganization() {
    if (confirmation !== 'DELETE') return;
    if (!window.confirm(`Permanently delete this ${subject} and its Adport Cloud data? This cannot be undone.`)) return;
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
      <div className="card-head"><h2>Delete {subject}</h2><span className="status critical">Irreversible</span></div>
      <div className="card-body stack">
        <p className="subhead">Deletes this project&apos;s encrypted credentials, memberships, API keys, pending approvals, and audit events. Google access is revoked before deletion; remove other provider grants in those platforms. The default project can only be deleted after other projects have been removed.</p>
        {error ? <div className="error-callout" role="alert" style={{ marginBottom: 0 }}>{error}</div> : null}
        <div className="form-row">
          <input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} placeholder="Type DELETE to confirm" aria-label="Type DELETE to confirm" style={{ maxWidth: '16rem' }} />
          <button className="button danger" disabled={busy || confirmation !== 'DELETE'} onClick={() => void deleteOrganization()}>{busy ? 'Deleting…' : `Delete ${subject}`}</button>
        </div>
      </div>
    </section>
  );
}
