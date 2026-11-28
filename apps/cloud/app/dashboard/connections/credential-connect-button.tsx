'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Input } from '@/components/controls';
import { Dialog } from '@/components/dialog';
import { Select } from '@/components/select';
import { providerLabel } from '@/lib/cloud/providers';
import type { CredentialProvider } from '@/lib/cloud/types';
import { MatomoOAuthForm } from './matomo-oauth-form';

interface ConnectionProps { organizationId: string; provider: CredentialProvider; returnTo?: string }

const gravityPermissions = [
  { value: 'read', label: 'Read campaigns and reports' },
  { value: 'write', label: 'Read and edit campaigns' },
  { value: 'spend', label: 'Read, edit and change spend' },
];

export function CredentialConnectButton({ connected, ...connection }: ConnectionProps & { connected: boolean }) {
  const [open, setOpen] = useState(false);
  const action = connected ? 'Reconnect' : 'Connect';
  return <><Button className="button secondary" type="button" onClick={() => setOpen(true)} aria-label={`${action} ${providerLabel(connection.provider)}`}>{action}</Button>
    {open ? <KeyDialog {...connection} onClose={() => setOpen(false)} /> : null}</>;
}

function GravityOAuthForm({ organizationId, returnTo, access, onAccessChange }: Pick<ConnectionProps, 'organizationId' | 'returnTo'> & {
  access: string; onAccessChange: (value: string) => void;
}) {
  const query = new URLSearchParams({ organization_id: organizationId, gravity_access: access });
  if (returnTo) query.set('return_to', returnTo);
  return <div className="stack">
    <label className="field"><span className="field-label">Gravity permissions</span>
      <Select aria-label="Gravity permissions" value={access} onValueChange={onAccessChange} options={gravityPermissions} />
    </label>
    <p>Sign in as a Gravity advertiser owner or admin and choose the advertiser to connect.</p>
    <a className="button" href={'/api/oauth/gravity/start?' + query}>Continue to Gravity</a>
  </div>;
}

function KeyDialog({ organizationId, provider, returnTo, onClose }: ConnectionProps & { onClose: () => void }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const matomo = provider === 'matomo';
  const [useToken, setUseToken] = useState(false);
  const [gravityAccess, setGravityAccess] = useState('spend');
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
    <div className="stack">
      {(matomo || provider === 'gravity') && <label className="field"><span className="field-label">Connection method</span>
        <Select aria-label="Connection method" value={useToken ? 'token' : 'oauth'} disabled={busy}
          onValueChange={value => setUseToken(value === 'token')} options={[
            { value: 'oauth', label: `Sign in with ${providerLabel(provider)}` },
            { value: 'token', label: matomo ? 'Use a personal auth token' : 'Use an advertiser API key' },
          ]} />
      </label>}
      {matomo && !useToken ? <MatomoOAuthForm organizationId={organizationId} returnTo={returnTo} />
        : provider === 'gravity' && !useToken ? <GravityOAuthForm organizationId={organizationId} returnTo={returnTo} access={gravityAccess} onAccessChange={setGravityAccess} />
        : <>
          {matomo ? <p>Create an auth token in Matomo under Administration → Personal → Security. The token needs view access to the sites you choose.</p>
            : provider === 'gravity' ? <p>An owner or admin can copy the advertiser API key from Settings → Organization in the <a href="https://app.trygravity.com" target="_blank" rel="noreferrer">Gravity dashboard</a>. Each key connects one advertiser.</p>
            : <p>Create an Advertiser API key in <a href="https://ads.openai.com/settings" target="_blank" rel="noreferrer">OpenAI Ads Manager settings</a>. Each key connects one ad account.</p>}
          <form className="stack" onSubmit={submit}>
            {matomo ? <label className="field"><span className="field-label">Matomo instance URL</span><Input type="url" name="url" placeholder="https://analytics.example.com/matomo" required maxLength={2048} autoComplete="off" spellCheck={false} disabled={busy} /></label> : null}
            <label className="field"><span className="field-label">{matomo ? 'Auth token' : 'Advertiser API key'}</span><Input name={matomo ? 'token_auth' : 'api_key'} type="password" required maxLength={4096} autoComplete="off" spellCheck={false} disabled={busy} /></label>
            <p className="field-hint">{matomo ? 'Your token is stored encrypted. You choose which sites assistants can read.' : 'Your key is stored encrypted for this project. You’ll choose account access before assistants can use it.'}</p>
            {error ? <p className="error-callout" role="alert">{error}</p> : null}
            <Button className="button" type="submit" pending={busy} pendingLabel="Verifying…">{matomo ? 'Verify and choose sites' : 'Verify and choose account'}</Button>
          </form>
        </>}
    </div>
  </Dialog>;
}
