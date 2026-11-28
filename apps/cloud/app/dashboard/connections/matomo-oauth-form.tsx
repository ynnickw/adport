'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { Button, Input } from '@/components/controls';

export function MatomoOAuthForm({ organizationId, returnTo }: { organizationId: string; returnTo?: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [instance, setInstance] = useState('');
  const [setup, setSetup] = useState(false);
  const [registration, setRegistration] = useState<{ instance: string; redirect: string }>();
  useEffect(() => {
    if (!setup || !instance) return;
    const controller = new AbortController();
    const timeout = setTimeout(async () => {
      try {
        const response = await fetch('/api/oauth/matomo/registration?' + new URLSearchParams({ instance }), { signal: controller.signal });
        if (response.ok) {
          const data = await response.json() as { redirect_uri: string };
          if (!controller.signal.aborted) setRegistration({ instance, redirect: data.redirect_uri });
        }
      } catch { /* An incomplete URL or a closed panel needs no error notice. */ }
    }, 250);
    return () => { clearTimeout(timeout); controller.abort(); };
  }, [instance, setup]);
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
      <Input name="url" type="url" value={instance} onChange={event => setInstance(event.target.value)} placeholder="https://analytics.example.com/matomo" required maxLength={2048} disabled={busy} /></label>
    <details onToggle={event => setSetup(event.currentTarget.open)}><summary>Set up this instance for the first time</summary>
      <p>In Matomo’s OAuth 2.0 settings, register a confidential client with authorization code, refresh tokens and the <code>matomo:read</code> scope. Use this callback URL.</p>
      {registration?.instance === instance && registration ? <p><code>{registration.redirect}</code></p> : <p>Enter your public HTTPS instance URL to see its callback.</p>}
      <label className="field"><span className="field-label">Client ID</span><Input name="client_id" autoComplete="off" maxLength={512} disabled={busy} /></label>
      <label className="field"><span className="field-label">Client secret</span><Input name="client_secret" type="password" autoComplete="off" maxLength={4096} disabled={busy} /></label>
    </details>
    {error && <p className="error-callout" role="alert">{error}</p>}
    <Button type="submit" className="button" pending={busy} pendingLabel="Connecting…">Continue to Matomo</Button>
  </form>;
}
