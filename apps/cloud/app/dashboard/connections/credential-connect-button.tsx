'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Input } from '@/components/controls';
import { Dialog } from '@/components/dialog';
import { providerLabel } from '@/lib/cloud/providers';

interface ConnectionProps { organizationId: string; provider: 'openai' | 'matomo'; returnTo?: string }

export function CredentialConnectButton({ connected, ...connection }: ConnectionProps & { connected: boolean }) {
  const [open, setOpen] = useState(false);
  const action = connected ? 'Reconnect' : 'Connect';
  return <><Button className="button secondary" type="button" onClick={() => setOpen(true)} aria-label={`${action} ${providerLabel(connection.provider)}`}>{action}</Button>
    {open ? <KeyDialog {...connection} onClose={() => setOpen(false)} /> : null}</>;
}

function KeyDialog({ organizationId, provider, returnTo, onClose }: ConnectionProps & { onClose: () => void }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const matomo = provider === 'matomo';
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = new FormData(form);
    const credentials = matomo ? { url: fields.get('url'), token_auth: fields.get('token_auth') } : { api_key: fields.get('api_key') };
    setBusy(true); setError(undefined);
    try {
      const response = await fetch(`/api/connections/${provider}`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ organization_id: organizationId, ...credentials, return_to: returnTo }) });
      const result = await response.json() as { redirect?: string; error?: string };
      if (!response.ok || !result.redirect) { setError(result.error ?? 'Connection failed. Please retry.'); return; }
      form.reset(); router.push(result.redirect);
    } catch { setError('Could not connect. Check your connection and retry.'); }
    finally { setBusy(false); }
  }
  return <Dialog title={`Connect ${providerLabel(provider)}`} onClose={() => { if (!busy) onClose(); }}>
    {matomo ? <p>Create an auth token in Matomo under Administration → Personal → Security. The token needs view access to the sites you choose.</p>
      : <p>Create an Advertiser API key in <a href="https://ads.openai.com/settings" target="_blank" rel="noreferrer">OpenAI Ads Manager settings</a>. Each key connects one ad account.</p>}
    <form className="stack" onSubmit={submit}>
      {matomo ? <label className="field"><span className="field-label">Matomo instance URL</span><Input type="url" name="url" placeholder="https://analytics.example.com/matomo" required maxLength={2048} autoComplete="off" spellCheck={false} disabled={busy} /></label> : null}
      <label className="field"><span className="field-label">{matomo ? 'Auth token' : 'Advertiser API key'}</span><Input name={matomo ? 'token_auth' : 'api_key'} type="password" required maxLength={4096} autoComplete="off" spellCheck={false} disabled={busy} /></label>
      <p className="field-hint">{matomo ? 'Your token is stored encrypted. You choose which sites assistants can read.' : 'Your key is stored encrypted for this project. You’ll choose account access before assistants can use it.'}</p>
      {error ? <p className="error-callout" role="alert">{error}</p> : null}
      <Button className="button" type="submit" pending={busy} pendingLabel="Verifying…">{matomo ? 'Verify and choose sites' : 'Verify and choose account'}</Button>
    </form>
  </Dialog>;
}
