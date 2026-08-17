'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';

type ManualProvider = 'meta' | 'tiktok' | 'apple' | 'microsoft' | 'reddit';
interface ConnectionSummary { provider: string; status: string; externalLabel: string | null; lastError: string | null; }
interface Field { name: string; label: string; secret?: boolean; optional?: boolean; multiline?: boolean; }

const providers: Array<{ id: ManualProvider; label: string; note: string; fields: Field[]; sandbox?: boolean }> = [
  {
    id: 'meta', label: 'Meta Ads', note: 'Marketing API user access token.',
    fields: [
      { name: 'accessToken', label: 'Access token', secret: true },
      { name: 'appId', label: 'App ID', optional: true },
      { name: 'appSecret', label: 'App secret', secret: true, optional: true },
    ],
  },
  {
    id: 'tiktok', label: 'TikTok Ads', note: 'Business API application credentials.', sandbox: true,
    fields: [
      { name: 'appId', label: 'App ID' },
      { name: 'secret', label: 'App secret', secret: true },
      { name: 'accessToken', label: 'Access token', secret: true },
    ],
  },
  {
    id: 'apple', label: 'Apple Ads', note: 'API user and ES256 private key.',
    fields: [
      { name: 'clientId', label: 'Client ID' },
      { name: 'teamId', label: 'Team ID' },
      { name: 'keyId', label: 'Key ID' },
      { name: 'privateKeyPem', label: 'Private key (.p8 PEM)', secret: true, multiline: true },
    ],
  },
  {
    id: 'microsoft', label: 'Microsoft Advertising', note: 'OAuth refresh token and developer application.', sandbox: true,
    fields: [
      { name: 'developerToken', label: 'Developer token', secret: true },
      { name: 'clientId', label: 'Client ID' },
      { name: 'clientSecret', label: 'Client secret', secret: true, optional: true },
      { name: 'refreshToken', label: 'Refresh token', secret: true },
    ],
  },
  {
    id: 'reddit', label: 'Reddit Ads', note: 'Ads API OAuth application credentials.',
    fields: [
      { name: 'clientId', label: 'Client ID' },
      { name: 'clientSecret', label: 'Client secret', secret: true },
      { name: 'refreshToken', label: 'Refresh token', secret: true },
      { name: 'userAgent', label: 'User agent' },
    ],
  },
];

export function ProviderConnections({ organizationId, connections }: {
  organizationId: string;
  connections: ConnectionSummary[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<ManualProvider>();
  const [messages, setMessages] = useState<Partial<Record<ManualProvider, { error?: string; success?: string }>>>({});

  async function connect(provider: ManualProvider, event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(provider);
    setMessages((current) => ({ ...current, [provider]: {} }));
    const form = event.currentTarget;
    const values = Object.fromEntries(new FormData(form).entries());
    for (const [key, value] of Object.entries(values)) if (value === '') delete values[key];
    const response = await fetch(`/api/connections/${provider}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...values, organizationId, sandbox: values.sandbox === 'on' }),
    });
    const result = await response.json() as { connected?: boolean; error?: string };
    if (!response.ok) {
      setMessages((current) => ({ ...current, [provider]: { error: result.error ?? 'Unable to connect provider.' } }));
    } else {
      form.reset();
      setMessages((current) => ({ ...current, [provider]: { success: 'Connected and verified.' } }));
      router.refresh();
    }
    setBusy(undefined);
  }

  async function disconnect(provider: ManualProvider) {
    if (!window.confirm(`Remove encrypted ${provider} credentials? You must also revoke them at the provider.`)) return;
    setBusy(provider);
    const response = await fetch(`/api/connections/${provider}?organization_id=${organizationId}`, { method: 'DELETE' });
    if (!response.ok) {
      setMessages((current) => ({ ...current, [provider]: { error: 'Unable to remove connection.' } }));
    } else {
      setMessages((current) => ({ ...current, [provider]: { success: 'Credentials removed. Revoke provider access separately.' } }));
      router.refresh();
    }
    setBusy(undefined);
  }

  return (
    <section className="card full">
      <div className="card-header"><div><h2>Additional providers</h2><span className="muted">Encrypted per tenant; secrets are never returned to the browser.</span></div></div>
      <div className="provider-grid">
        {providers.map((provider) => {
          const connection = connections.find((item) => item.provider === provider.id);
          const message = messages[provider.id];
          return (
            <article className="provider-card" key={provider.id}>
              <div className="card-header">
                <div><strong>{provider.label}</strong><div className="muted small">{provider.note}</div></div>
                {connection ? <span className={`status ${connection.status === 'error' ? 'error' : ''}`}>{connection.status}</span> : null}
              </div>
              {connection?.externalLabel ? <p className="muted small">{connection.externalLabel}</p> : null}
              {connection?.lastError ? <p className="error">Verification failed. Re-enter credentials to retry.</p> : null}
              {message?.error ? <p className="error">{message.error}</p> : null}
              {message?.success ? <p className="success">{message.success}</p> : null}
              <details open={!connection || connection.status === 'error'}>
                <summary>{connection ? 'Replace credentials' : 'Connect'}</summary>
                <form className="stack compact" onSubmit={(event) => void connect(provider.id, event)}>
                  {provider.fields.map((field) => (
                    <label key={field.name}>{field.label}{field.optional ? ' (optional)' : ''}
                      {field.multiline
                        ? <textarea name={field.name} required={!field.optional} rows={5} autoComplete="off" />
                        : <input name={field.name} type={field.secret ? 'password' : 'text'} required={!field.optional} autoComplete="off" />}
                    </label>
                  ))}
                  {provider.sandbox ? <label className="checkbox"><input name="sandbox" type="checkbox" /> Use provider sandbox</label> : null}
                  <button className="button" disabled={busy === provider.id}>{busy === provider.id ? 'Verifying…' : 'Encrypt and verify'}</button>
                </form>
              </details>
              {connection ? <button className="button danger" disabled={busy === provider.id} onClick={() => void disconnect(provider.id)}>Remove</button> : null}
            </article>
          );
        })}
      </div>
    </section>
  );
}
