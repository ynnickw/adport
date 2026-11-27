'use client';

import { useState, type FormEvent } from 'react';
import { Button, Input } from '@/components/controls';

export function MatomoOAuthForm({ organizationId, returnTo }: { organizationId: string; returnTo?: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    setError(''); setBusy(true);
    try {
      const response = await fetch('/api/oauth/matomo/start', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ organization_id: organizationId, return_to: returnTo, url: fields.get('url'),
          client_id: fields.get('client_id') || undefined, client_secret: fields.get('client_secret') || undefined }) });
      const result = await response.json() as { redirect?: string; error?: string };
      if (!response.ok || !result.redirect) throw new Error(result.error ?? 'Could not start Matomo authorization.');
      window.location.assign(result.redirect);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not start Matomo authorization.'); setBusy(false); }
  }
  return <form className="stack" onSubmit={submit}>
    <label className="field"><span className="field-label">Matomo instance URL</span>
      <Input name="url" type="url" placeholder="https://analytics.example.com/matomo" required maxLength={2048} disabled={busy} /></label>
    <details><summary>Set up this instance for the first time</summary>
      <p>In Matomo’s OAuth 2.0 settings, register a confidential client with authorization code, refresh tokens and the <code>matomo:read</code> scope. Use this callback URL.</p>
      <p><code>{window.location.origin}/api/oauth/matomo/callback</code></p>
      <label className="field"><span className="field-label">Client ID</span><Input name="client_id" autoComplete="off" maxLength={512} disabled={busy} /></label>
      <label className="field"><span className="field-label">Client secret</span><Input name="client_secret" type="password" autoComplete="off" maxLength={4096} disabled={busy} /></label>
    </details>
    {error && <p className="error-callout" role="alert">{error}</p>}
    <Button type="submit" className="button" pending={busy} pendingLabel="Connecting…">Continue to Matomo</Button>
  </form>;
}
