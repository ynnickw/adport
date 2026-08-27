'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';

export function OrganizationName({ organizationId, name, canManage }: {
  organizationId: string;
  name: string;
  canManage: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ error?: string; success?: string }>({});

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = String(new FormData(event.currentTarget).get('name') ?? '').trim();
    if (!value || value === name) return;
    setBusy(true);
    setMessage({});
    const response = await fetch('/api/settings', {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ organizationId, organizationName: value }),
    });
    const result = await response.json().catch(() => ({})) as { error?: string };
    if (!response.ok) setMessage({ error: result.error ?? 'Unable to rename the organization.' });
    else { setMessage({ success: 'Organization renamed.' }); router.refresh(); }
    setBusy(false);
  }

  return (
    <section className="card">
      <div className="card-head"><h2>Organization</h2></div>
      <div className="card-body stack" style={{ gap: '0.8rem' }}>
        {message.error ? <div className="error-callout" style={{ marginBottom: 0 }}>{message.error}</div> : null}
        {message.success ? <div className="callout success">{message.success}</div> : null}
        <form className="form-row" onSubmit={(event) => void save(event)}>
          <input
            name="name"
            defaultValue={name}
            aria-label="Organization name"
            maxLength={120}
            required
            disabled={!canManage}
            style={{ flex: 1, minWidth: '14rem', width: 'auto' }}
          />
          {canManage ? <button className="button secondary" disabled={busy}>{busy ? 'Renaming…' : 'Rename'}</button> : null}
        </form>
        {canManage ? null : <p className="inline-note">Owners and admins can rename the organization.</p>}
      </div>
    </section>
  );
}
