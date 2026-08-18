'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Provider, StatusPill, formatDate } from '@/components/ui';

export interface ConnectionView {
  provider: string;
  status: 'connected' | 'error' | 'revoked';
  externalLabel: string | null;
  lastError: string | null;
  connectedAt: string;
  lastVerifiedAt: string | null;
}

export interface OAuthProviderView {
  id: 'google' | 'meta' | 'tiktok' | 'microsoft' | 'reddit';
  available: boolean;
  flowLabel: string;
  scopes: string[];
  copy: string;
  manualRevocationUrl: string;
}

const APPLE_COPY = 'Apple Ads uses OAuth 2.0 client credentials instead of a browser consent redirect. Create an API user in Apple Ads, upload its public key, and enter the resulting identifiers here. The private key is encrypted for this organization and never returned.';

export function ProviderConnections({ organizationId, canManage, connections, oauthProviders }: {
  organizationId: string;
  canManage: boolean;
  connections: ConnectionView[];
  oauthProviders: OAuthProviderView[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string>();
  const [notice, setNotice] = useState<Partial<Record<string, { error?: string; success?: string }>>>({});

  function find(provider: string): ConnectionView | undefined {
    return connections.find((connection) => connection.provider === provider);
  }

  async function disconnect(provider: string, label: string, oauth: boolean) {
    const prompt = oauth
      ? `Disconnect ${label}? Adport will revoke its grant at the provider where the API allows it and delete the encrypted token.`
      : `Remove the encrypted ${label} credentials? You should also delete the API user or key inside ${label}.`;
    if (!window.confirm(prompt)) return;
    setBusy(provider);
    setNotice((current) => ({ ...current, [provider]: {} }));
    const response = await fetch(`/api/connections/${provider}?organization_id=${organizationId}`, { method: 'DELETE' });
    const result = await response.json().catch(() => ({})) as { error?: string; providerRevocationRequired?: boolean };
    if (!response.ok) {
      setNotice((current) => ({ ...current, [provider]: { error: result.error ?? `Unable to disconnect ${label}. Please retry.` } }));
    } else {
      setNotice((current) => ({
        ...current,
        [provider]: { success: result.providerRevocationRequired ? `${label} removed. Revoke Adport's access in your ${label} account settings as well.` : `${label} disconnected and its grant revoked.` },
      }));
      router.refresh();
    }
    setBusy(undefined);
  }

  async function connectApple(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy('apple');
    setNotice((current) => ({ ...current, apple: {} }));
    const form = event.currentTarget;
    const values = Object.fromEntries(new FormData(form).entries());
    const response = await fetch('/api/connections/apple', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...values, organizationId }),
    });
    const result = await response.json().catch(() => ({})) as { connected?: boolean; error?: string };
    if (!response.ok) {
      setNotice((current) => ({ ...current, apple: { error: result.error ?? 'Unable to connect Apple Ads.' } }));
    } else {
      form.reset();
      setNotice((current) => ({ ...current, apple: { success: 'Apple Ads connected and verified.' } }));
      router.refresh();
    }
    setBusy(undefined);
  }

  const apple = find('apple');

  return (
    <section className="connection-grid">
      {oauthProviders.map((provider) => {
        const connection = find(provider.id);
        const message = notice[provider.id];
        const startHref = `/api/oauth/${provider.id}/start?organization_id=${organizationId}`;
        return (
          <article className={`connection${connection ? '' : ' pending'}`} key={provider.id}>
            <div className="connection-top">
              <Provider name={provider.id} />
              {connection ? <StatusPill status={connection.status} /> : <span className={`status ${provider.available ? 'warn' : 'neutral'}`}>{provider.available ? 'OAuth' : 'Pending app'}</span>}
            </div>
            {connection ? (
              <dl className="connection-meta">
                <div><dt>Access</dt><dd>{connection.externalLabel ?? '—'}</dd></div>
                <div><dt>Flow</dt><dd>{provider.flowLabel}</dd></div>
                <div><dt>Verified</dt><dd>{formatDate(connection.lastVerifiedAt ?? connection.connectedAt)}</dd></div>
              </dl>
            ) : (
              <p className="connection-copy">{provider.copy}</p>
            )}
            {connection?.status === 'error' ? <div className="error-callout" style={{ marginBottom: '0.8rem' }}>{connection.lastError ?? 'Verification failed. Reconnect to retry.'}</div> : null}
            {message?.error ? <div className="error-callout" style={{ marginBottom: '0.8rem' }}>{message.error}</div> : null}
            {message?.success ? <div className="callout success" style={{ marginBottom: '0.8rem' }}>{message.success}</div> : null}
            {canManage ? (
              <div className="connection-actions">
                {!connection && provider.available ? <a className="button" href={startHref}>Connect {shortLabel(provider.id)}</a> : null}
                {!connection && !provider.available ? <button className="button" type="button" disabled>Awaiting app approval</button> : null}
                {connection && provider.available ? <a className="button secondary" href={startHref}>{connection.status === 'error' ? 'Reconnect' : 'Re-authorize'}</a> : null}
                {connection ? <button className="button danger" type="button" disabled={busy === provider.id} onClick={() => void disconnect(provider.id, shortLabel(provider.id), true)}>{busy === provider.id ? 'Working…' : 'Disconnect'}</button> : null}
              </div>
            ) : (
              <p className="inline-note">Owners and admins manage connections.</p>
            )}
            {!connection && !provider.available ? <p className="inline-note" style={{ marginTop: '0.7rem' }}>Adport&apos;s {shortLabel(provider.id)} application is under review with the platform. This card activates automatically once the app is approved and configured.</p> : null}
          </article>
        );
      })}

      <article className={`connection${apple ? '' : ' pending'}`}>
        <div className="connection-top">
          <Provider name="apple" />
          {apple ? <StatusPill status={apple.status} /> : <span className="status neutral">OAuth 2.0</span>}
        </div>
        {apple ? (
          <dl className="connection-meta">
            <div><dt>Access</dt><dd>{apple.externalLabel ?? '—'}</dd></div>
            <div><dt>Flow</dt><dd>OAuth 2.0 client credentials (ES256 API user)</dd></div>
            <div><dt>Verified</dt><dd>{formatDate(apple.lastVerifiedAt ?? apple.connectedAt)}</dd></div>
          </dl>
        ) : (
          <p className="connection-copy">{APPLE_COPY}</p>
        )}
        {apple?.status === 'error' ? <div className="error-callout" style={{ marginBottom: '0.8rem' }}>Verification failed. Replace the credentials to retry.</div> : null}
        {notice.apple?.error ? <div className="error-callout" style={{ marginBottom: '0.8rem' }}>{notice.apple.error}</div> : null}
        {notice.apple?.success ? <div className="callout success" style={{ marginBottom: '0.8rem' }}>{notice.apple.success}</div> : null}
        {canManage ? (
          <>
            <details className="connection-form" open={!apple || apple.status === 'error'}>
              <summary>{apple ? 'Replace API user credentials' : 'Enter API user credentials'}</summary>
              <form className="form compact" onSubmit={(event) => void connectApple(event)}>
                <label className="field"><span>Client ID</span><input name="clientId" required autoComplete="off" placeholder="SEARCHADS.xxxxxxxx" /></label>
                <div className="field-grid">
                  <label className="field"><span>Team ID</span><input name="teamId" required autoComplete="off" /></label>
                  <label className="field"><span>Key ID</span><input name="keyId" required autoComplete="off" /></label>
                </div>
                <label className="field"><span>Private key (.p8 PEM)</span><textarea name="privateKeyPem" required rows={5} autoComplete="off" placeholder="Paste the complete .p8 PEM contents" /></label>
                <div className="form-actions">
                  <button className="button" disabled={busy === 'apple'}>{busy === 'apple' ? 'Verifying…' : 'Encrypt and verify'}</button>
                  {apple ? <button className="button danger" type="button" disabled={busy === 'apple'} onClick={() => void disconnect('apple', 'Apple Ads', false)}>Remove</button> : null}
                </div>
              </form>
            </details>
            <p className="inline-note" style={{ marginTop: '0.8rem' }}>Setup: Apple Ads → Account Settings → API → create an API user, generate an EC P-256 key pair, and upload the public key. Adport uses those credentials to request short-lived OAuth access tokens from Apple.</p>
          </>
        ) : (
          <p className="inline-note">Owners and admins manage connections.</p>
        )}
      </article>
    </section>
  );
}

function shortLabel(provider: string): string {
  return { google: 'Google Ads', meta: 'Meta', tiktok: 'TikTok', microsoft: 'Microsoft', reddit: 'Reddit' }[provider] ?? provider;
}
