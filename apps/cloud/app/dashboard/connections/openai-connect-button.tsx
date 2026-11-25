'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Input } from '@/components/controls';
import { Dialog } from '@/components/dialog';

export function OpenAIConnectButton({ organizationId, connected }: { organizationId: string; connected: boolean }) {
  const [open, setOpen] = useState(false);
  return <><Button className="button secondary" type="button" onClick={() => setOpen(true)} aria-label={connected ? 'Reconnect OpenAI Ads' : 'Connect OpenAI Ads'}>{connected ? 'Reconnect' : 'Connect'}</Button>
    {open ? <KeyDialog organizationId={organizationId} onClose={() => setOpen(false)} /> : null}</>;
}

function KeyDialog({ organizationId, onClose }: { organizationId: string; onClose: () => void }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const apiKey = new FormData(form).get('api_key');
    setBusy(true); setError(undefined);
    try {
      const response = await fetch('/api/connections/openai', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ organization_id: organizationId, api_key: apiKey }) });
      const result = await response.json() as { redirect?: string; error?: string };
      if (!response.ok || !result.redirect) { setError(result.error ?? 'Connection failed. Please retry.'); return; }
      form.reset(); router.push(result.redirect);
    } catch { setError('Could not connect. Check your connection and retry.'); }
    finally { setBusy(false); }
  }
  return <Dialog title="Connect OpenAI Ads" onClose={() => { if (!busy) onClose(); }}>
    <p>Create an Advertiser API key in <a href="https://ads.openai.com/settings" target="_blank" rel="noreferrer">OpenAI Ads Manager settings</a>. Each key connects one ad account.</p>
    <form className="stack" onSubmit={submit}>
      <label className="field"><span className="field-label">Advertiser API key</span><Input name="api_key" type="password" required maxLength={4096} autoComplete="off" spellCheck={false} disabled={busy} /></label>
      <p className="field-hint">Your key is stored encrypted for this project. You’ll choose account access before assistants can use it.</p>
      {error ? <p className="error-callout" role="alert">{error}</p> : null}
      <Button className="button" type="submit" pending={busy} pendingLabel="Verifying…">Verify and choose account</Button>
    </form>
  </Dialog>;
}
