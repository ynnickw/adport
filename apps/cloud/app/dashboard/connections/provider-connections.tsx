'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
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
  id: 'google' | 'meta' | 'tiktok' | 'microsoft' | 'reddit' | 'apple';
  available: boolean;
  flowLabel: string;
  scopes: string[];
  copy: string;
  manualRevocationUrl: string;
}

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

  async function disconnect(provider: string, label: string) {
    const prompt = `Disconnect ${label}? Adport will revoke its grant at the provider where the API allows it and delete the encrypted token.`;
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
              connection || provider.available ? (
                <div className="connection-actions">
                  {!connection && provider.available ? <a className="button" href={startHref}>Connect {shortLabel(provider.id)}</a> : null}
                  {connection && provider.available ? <a className="button secondary" href={startHref}>{connection.status === 'error' ? 'Reconnect' : 'Re-authorize'}</a> : null}
                  {connection ? <button className="button danger" type="button" disabled={busy === provider.id} onClick={() => void disconnect(provider.id, shortLabel(provider.id))}>{busy === provider.id ? 'Working…' : 'Disconnect'}</button> : null}
                </div>
              ) : null
            ) : (
              <p className="inline-note">Owners and admins manage connections.</p>
            )}
            {!connection && !provider.available ? <p className="inline-note">Available once Adport&apos;s {shortLabel(provider.id)} app is approved by the platform.</p> : null}
          </article>
        );
      })}
    </section>
  );
}

function shortLabel(provider: string): string {
  return { google: 'Google Ads', meta: 'Meta', tiktok: 'TikTok', microsoft: 'Microsoft', reddit: 'Reddit', apple: 'Apple Ads' }[provider] ?? provider;
}
