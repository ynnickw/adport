'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Provider, StatusPill, formatDate } from '@/components/ui';
import { providerLabel } from '@/lib/cloud/providers';
import type { OAuthProvider } from '@/lib/cloud/types';
import { OAuthPopupLink } from '@/components/oauth-popup-link';

export interface ConnectionView {
  provider: string;
  status: 'connected' | 'error' | 'revoked';
  externalLabel: string | null;
  lastError: string | null;
  connectedAt: string;
  lastVerifiedAt: string | null;
  accountSelectionId?: string | null;
}

export interface OAuthProviderView {
  id: OAuthProvider;
  available: boolean;
}

export function ProviderConnections({ organizationId, canManage, connections, oauthProviders, returnTo }: {
  organizationId: string;
  canManage: boolean;
  connections: ConnectionView[];
  oauthProviders: OAuthProviderView[];
  returnTo?: string;
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
    <section aria-label="Provider connections">
      {!canManage ? <p className="inline-note">Owners and admins manage connections.</p> : null}
      <div className="connection-list">
      <div className="connection-list-heading" aria-hidden="true"><span>Platform</span><span>Status</span><span>Accounts</span><span>Actions</span></div>
      <ul className="connection-rows" role="list">
      {oauthProviders.map((provider) => {
        const connection = find(provider.id);
        const message = notice[provider.id];
        const startHref = `/api/oauth/${provider.id}/start?organization_id=${organizationId}${returnTo ? `&return_to=${encodeURIComponent(returnTo)}` : ''}`;
        return (
          <li className="connection-row" key={provider.id} aria-label={providerLabel(provider.id)}>
            <Provider name={provider.id} />
            <div className="connection-status" title={connection ? `Last verified: ${formatDate(connection.lastVerifiedAt ?? connection.connectedAt)}` : undefined}>
              {connection?.accountSelectionId && connection.status === 'connected' ? <span className="status neutral">Choose accounts</span> : connection ? <StatusPill status={connection.status} /> : <span className="status neutral">{provider.available ? 'Not connected' : 'Unavailable'}</span>}
            </div>
            <div className="connection-accounts">
              {connection?.accountSelectionId && connection.status === 'connected' ? (
                canManage ? <a href={`/account-selection?selection_id=${connection.accountSelectionId}`}>Finish selection</a> : <span>Selection pending</span>
              ) : connection?.status === 'connected' ? (
                <a href={`/dashboard/accounts?select_provider=${provider.id}`} aria-label={`View ${providerLabel(provider.id)} accounts`}>
                  {accountSummary(connection.externalLabel)}
                </a>
              ) : <span>{connection ? 'Reconnect to verify' : '—'}</span>}
            </div>
            <div className="connection-actions">
            {canManage ? (
              connection || provider.available ? (
                <>
                  {!connection && provider.available ? <OAuthPopupLink className="button" label={`Connect ${providerLabel(provider.id)}`} href={startHref}>Connect</OAuthPopupLink> : null}
                  {connection && provider.available ? <OAuthPopupLink className="button secondary" label={`${connection.status !== 'connected' ? 'Reconnect' : 'Re-authorize'} ${providerLabel(provider.id)}`} href={startHref}>{connection.status !== 'connected' ? 'Reconnect' : 'Re-authorize'}</OAuthPopupLink> : null}
                  {connection ? <button className="button danger" aria-label={`Disconnect ${providerLabel(provider.id)}`} type="button" disabled={busy === provider.id} onClick={() => void disconnect(provider.id, shortLabel(provider.id))}>{busy === provider.id ? 'Working…' : 'Disconnect'}</button> : null}
                </>
              ) : null
            ) : (
              <span className="inline-note">View only</span>
            )}
            </div>
            {connection?.status === 'error' ? <div className="error-callout connection-feedback" role="alert">{connection.lastError ?? 'Verification failed. Reconnect to retry.'}</div> : null}
            {message?.error ? <div className="error-callout connection-feedback" role="alert">{message.error}</div> : null}
            {message?.success ? <div className="callout success connection-feedback" role="status">{message.success}</div> : null}
          </li>
        );
      })}
      </ul>
      </div>
    </section>
  );
}

function accountSummary(label: string | null): string {
  const count = label?.match(/^(\d+) (?:accessible|added) .+ account\(s\)$/)?.[1];
  return count ? `${count} ${count === '1' ? 'account' : 'accounts'}` : label ?? 'View accounts';
}

function shortLabel(provider: string): string {
  return { google: 'Google Ads', meta: 'Meta', tiktok: 'TikTok', microsoft: 'Microsoft', reddit: 'Reddit', apple: 'Apple Ads', snapchat: 'Snapchat', spotify: 'Spotify', pinterest: 'Pinterest', linkedin: 'LinkedIn', x: 'X Ads' }[provider] ?? provider;
}
