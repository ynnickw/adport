'use client';

import { Button } from '@/components/controls';

import { useRouter } from 'next/navigation';
import { Fragment, useState } from 'react';
import { Provider, StatusPill, formatDate } from '@/components/ui';
import { providerLabel, providerAccountsPath, usesAdAccountSlot } from '@/lib/cloud/providers';
import type { OAuthProvider } from '@/lib/cloud/types';
import { OAuthPopupLink } from '@/components/oauth-popup-link';
import { useConfirm } from '@/components/use-confirm';
import { InfoTooltip } from '@/components/info-tooltip';

export interface ConnectionView {
  provider: string;
  status: 'connected' | 'error' | 'revoked';
  externalLabel: string | null;
  lastError: string | null;
  connectedAt: string;
  lastVerifiedAt: string | null;
  accountSelectionId?: string | null;
  accountSelectionUnavailable?: boolean;
  dataManagerEnabled?: boolean;
  pinManagementEnabled?: boolean;
  secretPinsEnabled?: boolean;
  catalogManagementEnabled?: boolean;
}

export interface OAuthProviderView {
  id: OAuthProvider;
  available: boolean;
}

export function ProviderConnections({ organizationId, canManage, connections, oauthProviders, returnTo, variant = 'settings' }: {
  organizationId: string;
  canManage: boolean;
  connections: ConnectionView[];
  oauthProviders: OAuthProviderView[];
  returnTo?: string;
  variant?: 'settings' | 'onboarding';
}) {
  const router = useRouter();
  const [confirm, confirmationDialog] = useConfirm();
  const [busy, setBusy] = useState<string>();
  const [notice, setNotice] = useState<Partial<Record<string, { error?: string; success?: string }>>>({});
  const visibleProviders = oauthProviders.filter(provider => provider.available || find(provider.id)).sort((a, b) => Number(!usesAdAccountSlot(a.id)) - Number(!usesAdAccountSlot(b.id)) || Number(!find(a.id)) - Number(!find(b.id)));

  function find(provider: string): ConnectionView | undefined {
    return connections.find((connection) => connection.provider === provider);
  }

  async function disconnect(provider: string, label: string) {
    const prompt = `Remove ${label} and its accounts from this project? Adport and connected assistants will lose access. ${usesAdAccountSlot(provider) ? 'Your campaigns keep running. ' : ''}You can reconnect later.`;
    if (!await confirm({ title: `Disconnect ${label}?`, description: prompt, confirmLabel: 'Disconnect' })) return;
    setBusy(provider);
    setNotice((current) => ({ ...current, [provider]: {} }));
    try {
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
    } catch {
      setNotice(current => ({ ...current, [provider]: { error: 'Could not disconnect. Check your connection and try again.' } }));
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <section aria-label="Provider connections" className={variant === 'onboarding' ? 'onboarding-platforms' : undefined}>
      {confirmationDialog}
      {!canManage ? <p className="inline-note">Owners and admins manage connections.</p> : null}
      {!visibleProviders.length ? <div className="card"><div className="empty"><h2>Platform connections are temporarily unavailable</h2><p>{canManage ? 'You can finish setup now and connect your accounts later. Contact support if this continues.' : 'Ask your organization owner or an admin to connect an ad platform.'}</p></div></div> : <>
      <div className="connection-list">
      <div className="connection-list-heading" aria-hidden="true"><span>Platform</span><span>Status</span><span>Accounts</span><span>Actions</span></div>
      <ul className="connection-rows" role="list">
      {visibleProviders.map((provider, index) => {
        const connection = find(provider.id);
        const message = notice[provider.id];
        const startHref = `/api/oauth/${provider.id}/start?organization_id=${organizationId}${returnTo ? `&return_to=${encodeURIComponent(returnTo)}` : ''}${provider.id === 'google' && connection?.dataManagerEnabled ? '&data_manager=1' : ''}${provider.id === 'pinterest' ? `${connection?.secretPinsEnabled ? '&secret_pins=1' : connection?.pinManagementEnabled ? '&pin_management=1' : ''}${connection?.catalogManagementEnabled ? '&catalog_management=1' : ''}` : ''}`;
        return (
          <Fragment key={provider.id}>
          {visibleProviders.some(item => !usesAdAccountSlot(item.id)) && visibleProviders.some(item => usesAdAccountSlot(item.id))
            && (index === 0 || usesAdAccountSlot(visibleProviders[index - 1]!.id) !== usesAdAccountSlot(provider.id))
            ? <li className="connection-category-heading"><h3>{usesAdAccountSlot(provider.id) ? 'Ad platforms' : 'Analytics & tracking'}</h3></li> : null}
          <li className="connection-row" data-connected={Boolean(connection)} id={'platform-' + provider.id} key={provider.id} aria-label={providerLabel(provider.id)}>
            <Provider name={provider.id} />
            <div className="connection-status">
              {connection?.accountSelectionId && connection.status === 'connected' ? <span className={'status ' + (connection.accountSelectionUnavailable ? 'warn' : 'neutral')}>{connection.accountSelectionUnavailable ? 'Restart selection' : 'Choose accounts'}</span> : connection ? <StatusPill status={connection.status} /> : <span className="status neutral">{provider.available ? 'Not connected' : 'Unavailable'}</span>}
              {connection ? <InfoTooltip label={'Connection details for ' + providerLabel(provider.id)}>Last verified {formatDate(connection.lastVerifiedAt ?? connection.connectedAt)}. Connecting a platform and enabling individual accounts are separate steps.</InfoTooltip> : null}
            </div>
            <div className="connection-accounts">
              {connection?.accountSelectionId && connection.status === 'connected' ? (
                canManage && !connection.accountSelectionUnavailable ? <a href={`/account-selection?selection_id=${connection.accountSelectionId}`}>Finish selection</a> : <span>{connection.accountSelectionUnavailable ? 'New authorization needed' : 'Selection pending'}</span>
              ) : connection?.status === 'connected' ? (
                <a href={providerAccountsPath(provider.id)} aria-label={`View ${providerLabel(provider.id)} accounts`}>
                  {accountSummary(connection.externalLabel)}
                </a>
              ) : <span>{connection ? 'Reconnect to verify' : '—'}</span>}
            </div>
            <div className="connection-actions">
            {canManage ? (
              connection || provider.available ? (
                <>
                  {!connection && provider.available ? <OAuthPopupLink className="button" label={`Connect ${providerLabel(provider.id)}`} href={startHref}>Connect</OAuthPopupLink> : null}
                  {connection?.accountSelectionId && connection.status === 'connected' && !connection.accountSelectionUnavailable ? <a className="button secondary" href={'/account-selection?selection_id=' + connection.accountSelectionId}>Choose accounts</a>
                    : connection && provider.available ? <OAuthPopupLink className="button secondary" label={`${connection.status !== 'connected' ? 'Reconnect' : connection.accountSelectionUnavailable ? 'Restart selection for' : 'Change accounts for'} ${providerLabel(provider.id)}`} href={startHref}>{connection.status !== 'connected' ? 'Reconnect' : connection.accountSelectionUnavailable ? 'Restart selection' : 'Change accounts'}</OAuthPopupLink> : null}
                  {provider.id === 'google' && provider.available && connection?.status === 'connected' && !connection.accountSelectionId && !connection.dataManagerEnabled && variant === 'settings' ? <OAuthPopupLink className="button secondary" label="Authorize Google conversion imports with additional Data Manager permission" href={`${startHref}&data_manager=1`}>Enable conversion imports</OAuthPopupLink> : null}
                  {provider.id === 'pinterest' && provider.available && connection && !connection.accountSelectionId && !connection.pinManagementEnabled && !connection.secretPinsEnabled && variant === 'settings' ? <OAuthPopupLink className="button secondary" label="Authorize Pinterest public board, Pin and media management with additional permissions" href={`${startHref}&pin_management=1`}>Enable Pin management</OAuthPopupLink> : null}
                  {provider.id === 'pinterest' && provider.available && connection?.pinManagementEnabled && !connection.accountSelectionId && !connection.secretPinsEnabled && variant === 'settings' ? <OAuthPopupLink className="button secondary" label="Authorize Pinterest secret board and Pin management with four additional private-content permissions" href={`${startHref}&secret_pins=1`}>Enable secret Pin management</OAuthPopupLink> : null}
                  {provider.id === 'pinterest' && provider.available && connection?.status === 'connected' && !connection.accountSelectionId && !connection.catalogManagementEnabled && variant === 'settings' ? <OAuthPopupLink className="button secondary" label="Authorize Pinterest catalogs and feeds with two additional catalog permissions" href={`${startHref}&catalog_management=1`}>Enable catalogs</OAuthPopupLink> : null}
                  {connection && variant !== 'onboarding' ? <Button className="button secondary small" aria-label={`Disconnect ${providerLabel(provider.id)}`} type="button" disabled={busy === provider.id} onClick={() => void disconnect(provider.id, shortLabel(provider.id))}>{busy === provider.id ? 'Disconnecting…' : 'Disconnect'}</Button> : null}
                </>
              ) : null
            ) : (
              <span className="inline-note">View only</span>
            )}
            </div>
            {connection?.status === 'error' ? <div className="error-callout connection-feedback" role="alert">{connection.lastError ?? 'Verification failed. Reconnect to retry.'}</div> : null}
            {connection?.accountSelectionUnavailable && !provider.available ? <div className="error-callout connection-feedback" role="alert">This platform connection needs to be restarted, but new authorization is currently unavailable. Contact support.</div> : null}
            {message?.error ? <div className="error-callout connection-feedback" role="alert">{message.error}</div> : null}
            {message?.success ? <div className="callout success connection-feedback" role="status">{message.success}</div> : null}
          </li></Fragment>
        );
      })}
      </ul>
      </div>
      </>}
    </section>
  );
}

function accountSummary(label: string | null): string {
  const count = label?.match(/^(\d+) (?:accessible|added) .+ account\(s\)$/)?.[1];
  return count ? `${count} ${count === '1' ? 'account' : 'accounts'}` : label ?? 'View accounts';
}

function shortLabel(provider: string): string {
  return { gtm: 'Google Tag Manager', google: 'Google Ads', meta: 'Meta', tiktok: 'TikTok', microsoft: 'Microsoft', reddit: 'Reddit', apple: 'Apple Ads', snapchat: 'Snapchat', spotify: 'Spotify', pinterest: 'Pinterest', linkedin: 'LinkedIn', x: 'X Ads' }[provider] ?? provider;
}
