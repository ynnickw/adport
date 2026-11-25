'use client';

import { Button } from '@/components/controls';
import { ActionPopover } from '@/components/action-popover';
import { FilterButtons } from '@/components/list-controls';
import { Notice } from '@/components/feedback';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Fragment, useState } from 'react';
import { Provider, formatDate } from '@/components/ui';
import { providerLabel, providerAccountsPath, providerResourceName, usesAdAccountSlot } from '@/lib/cloud/providers';
import type { CloudProvider } from '@/lib/cloud/types';
import { OpenAIConnectButton } from './openai-connect-button';
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
  redditConversionsEnabled?: boolean;
  pinManagementEnabled?: boolean;
  secretPinsEnabled?: boolean;
  catalogManagementEnabled?: boolean;
}

export interface OAuthProviderView {
  id: CloudProvider;
  available: boolean;
}

export function ProviderConnections({ organizationId, projectName, canManage, connections, oauthProviders, returnTo, variant = 'settings' }: {
  organizationId: string;
  projectName: string;
  canManage: boolean;
  connections: ConnectionView[];
  oauthProviders: OAuthProviderView[];
  returnTo?: string;
  variant?: 'settings' | 'onboarding' | 'chooser';
}) {
  const router = useRouter();
  const [confirm, confirmationDialog] = useConfirm();
  const [busy, setBusy] = useState<string>();
  const [notice, setNotice] = useState<Partial<Record<string, { error?: string; success?: string }>>>({});
  const [filter, setFilter] = useState<'all' | 'attention' | 'connected' | 'available'>('all');
  const settings = variant === 'settings';
  const chooser = variant === 'chooser';
  const roster = oauthProviders.filter(provider => provider.available || find(provider.id));
  const needsAttention = (connection?: ConnectionView) => Boolean(connection && (connection.status !== 'connected' || connection.accountSelectionId));
  const attention = roster.filter(provider => needsAttention(find(provider.id))).length;
  const connected = roster.filter(provider => find(provider.id) && !needsAttention(find(provider.id))).length;
  const visibleProviders = roster.filter(provider => {
    if (!settings || filter === 'all') return true;
    const connection = find(provider.id);
    return filter === 'attention' ? needsAttention(connection) : filter === 'connected' ? connection && !needsAttention(connection) : !connection;
  }).sort((a, b) => Number(!usesAdAccountSlot(a.id)) - Number(!usesAdAccountSlot(b.id)) || Number(!needsAttention(find(a.id))) - Number(!needsAttention(find(b.id))) || Number(!find(a.id)) - Number(!find(b.id)));

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
    <section aria-label="Provider connections" className={variant === 'onboarding' ? 'onboarding-platforms' : chooser ? 'provider-chooser' : 'provider-settings'}>
      {confirmationDialog}
      {!canManage ? <p className="inline-note">Owners and admins manage connections.</p> : null}
      {Object.entries(notice).map(([id, message]) => message?.error ? <Notice key={id} tone="error">{message.error}</Notice>
        : message?.success ? <Notice key={id} tone="success">{message.success}</Notice> : null)}
      {!roster.length ? <div className="card"><div className="empty"><h2>Platform connections are temporarily unavailable</h2><p>{canManage ? 'You can finish setup now and connect your accounts later. Contact support if this continues.' : 'Ask your organization owner or an admin to connect an ad platform.'}</p></div></div> : <>
      <div className="connection-list">
      {settings ? <FilterButtons className="connection-filters" label="Filter platforms" value={filter} onChange={setFilter}
        options={([['all', 'All', roster.length], ['attention', 'Needs attention', attention], ['connected', 'Connected', connected], ['available', 'Not connected', roster.length - attention - connected]] as const)
          .map(([value, label, count]) => ({ value, label, count }))} /> : null}
      {!visibleProviders.length ? <div className="empty compact-empty"><h3>No matching platforms</h3><Button type="button" className="button secondary small" onClick={() => setFilter('all')}>Show all platforms</Button></div> : null}
      {visibleProviders.length ? <div className="connection-list-heading" aria-hidden="true"><span>Platform</span><span>Status</span><span>{oauthProviders.every(provider => !usesAdAccountSlot(provider.id)) ? 'Sources' : 'Accounts'}</span><span>Actions</span></div> : null}
      <ul className="connection-rows" role="list">
      {visibleProviders.map((provider, index) => {
        const connection = find(provider.id);
        const platform = providerLabel(provider.id);
        const resources = providerResourceName(provider.id);
        const healthy = Boolean(connection && !needsAttention(connection));
        const resumeHref = connection?.status === 'connected' && connection.accountSelectionId && !connection.accountSelectionUnavailable ? '/account-selection?selection_id=' + connection.accountSelectionId : undefined;
        const startHref = `/api/oauth/${provider.id}/start?organization_id=${organizationId}${returnTo ? `&return_to=${encodeURIComponent(returnTo)}` : ''}${provider.id === 'google' && connection?.dataManagerEnabled ? '&data_manager=1' : ''}${provider.id === 'reddit' && connection?.redditConversionsEnabled ? '&conversions=1' : ''}${provider.id === 'pinterest' ? `${connection?.secretPinsEnabled ? '&secret_pins=1' : connection?.pinManagementEnabled ? '&pin_management=1' : ''}${connection?.catalogManagementEnabled ? '&catalog_management=1' : ''}` : ''}`;
        const connectLabel = !connection ? 'Connect' : connection.status === 'connected' && connection.accountSelectionUnavailable ? 'Restart selection' : healthy ? `Find ${resources}` : 'Reconnect';
        const connect = canManage && provider.available ? provider.id === 'openai'
          ? <OpenAIConnectButton organizationId={organizationId} connected={Boolean(connection)} />
          : <OAuthPopupLink platform={platform} resourceProvider={provider.id} projectName={projectName} className="button secondary" label={`${connectLabel} ${healthy || connectLabel === 'Restart selection' ? 'for ' : ''}${platform}`} href={startHref}>{connectLabel}</OAuthPopupLink> : null;
        const mainAction = !canManage ? null : resumeHref
          ? <Link className="button" prefetch={false} href={resumeHref}>Choose {resources}</Link>
          : healthy && settings ? <Link className="button secondary" href={providerAccountsPath(provider.id)}>View {resources}</Link> : connect;
        return (
          <Fragment key={provider.id}>
          {visibleProviders.some(item => !usesAdAccountSlot(item.id)) && visibleProviders.some(item => usesAdAccountSlot(item.id))
            && (index === 0 || usesAdAccountSlot(visibleProviders[index - 1]!.id) !== usesAdAccountSlot(provider.id))
            ? <li className="connection-category-heading"><h3>{usesAdAccountSlot(provider.id) ? 'Ad platforms' : 'Analytics & tracking'}</h3></li> : null}
          <li className="connection-row" data-connected={Boolean(connection)} id={'platform-' + provider.id} key={provider.id} aria-label={providerLabel(provider.id)}>
            <Provider name={provider.id} />
            <div className="connection-status">
              <span className={`status ${healthy ? '' : connection ? 'warn' : 'neutral'}`}>{healthy ? 'Connected' : resumeHref ? 'Selection pending' : connection?.accountSelectionUnavailable && connection.status === 'connected' ? 'Selection expired or unavailable' : connection ? 'Reconnect needed' : 'Not connected'}</span>
              {connection && settings ? <InfoTooltip label={'Connection details for ' + platform}>Last verified {formatDate(connection.lastVerifiedAt ?? connection.connectedAt)}.</InfoTooltip> : null}
            </div>
            <div className="connection-accounts">
              {healthy ? accountSummary(provider.id, connection?.externalLabel ?? null) : '—'}
            </div>
            <div className="connection-actions">
            {canManage ? mainAction : healthy ? <Link className="button secondary" href={providerAccountsPath(provider.id)}>View {resources}</Link> : null}
            {canManage && connection && settings ? <ActionPopover label={`Manage ${platform}`} triggerLabel="Manage" panelClassName="row-action-panel">
              {close => <>
                  {healthy ? connect : null}
                  {provider.id === 'google' && provider.available && connection?.status === 'connected' && !connection.accountSelectionId && !connection.dataManagerEnabled && variant === 'settings' ? <OAuthPopupLink platform={platform} projectName={projectName} className="button secondary" label="Authorize Google conversion imports with additional Data Manager permission" href={`${startHref}&data_manager=1`}>Enable conversion imports</OAuthPopupLink> : null}
                  {provider.id === 'reddit' && provider.available && connection?.status === 'connected' && !connection.accountSelectionId && !connection.redditConversionsEnabled && variant === 'settings' ? <OAuthPopupLink platform={platform} projectName={projectName} className="button secondary" label="Authorize Reddit conversion events with the additional adsconversions permission" href={`${startHref}&conversions=1`}>Enable conversion events</OAuthPopupLink> : null}
                  {provider.id === 'pinterest' && provider.available && connection && !connection.accountSelectionId && !connection.pinManagementEnabled && !connection.secretPinsEnabled && variant === 'settings' ? <OAuthPopupLink platform={platform} projectName={projectName} className="button secondary" label="Authorize Pinterest public board, Pin and media management with additional permissions" href={`${startHref}&pin_management=1`}>Enable Pin management</OAuthPopupLink> : null}
                  {provider.id === 'pinterest' && provider.available && connection?.pinManagementEnabled && !connection.accountSelectionId && !connection.secretPinsEnabled && variant === 'settings' ? <OAuthPopupLink platform={platform} projectName={projectName} className="button secondary" label="Authorize Pinterest secret board and Pin management with four additional private-content permissions" href={`${startHref}&secret_pins=1`}>Enable secret Pin management</OAuthPopupLink> : null}
                  {provider.id === 'pinterest' && provider.available && connection?.status === 'connected' && !connection.accountSelectionId && !connection.catalogManagementEnabled && variant === 'settings' ? <OAuthPopupLink platform={platform} projectName={projectName} className="button secondary" label="Authorize Pinterest catalogs and feeds with two additional catalog permissions" href={`${startHref}&catalog_management=1`}>Enable catalogs</OAuthPopupLink> : null}
                  <Button className="button secondary small" aria-label={`Disconnect ${platform}`} type="button" pending={busy === provider.id} pendingLabel="Disconnecting…" onClick={() => { close(); void disconnect(provider.id, shortLabel(provider.id)); }}>Disconnect</Button>
              </>}
            </ActionPopover> : null}
            </div>
            {connection?.status === 'error' && !chooser ? <Notice tone="error" className="connection-feedback">{connection.lastError ?? 'Verification failed. Reconnect to retry.'}</Notice> : null}
            {connection?.accountSelectionUnavailable && !provider.available ? <Notice tone="error" className="connection-feedback">This platform connection needs to be restarted, but new authorization is currently unavailable. Contact support.</Notice> : null}
          </li></Fragment>
        );
      })}
      </ul>
      </div>
      </>}
    </section>
  );
}

function accountSummary(provider: string, label: string | null): string {
  const count = label?.match(/^(\d+) (?:accessible|added) .+ account\(s\)$/)?.[1];
  return count ? `${count} ${providerResourceName(provider, Number(count))}` : label ?? '—';
}

function shortLabel(provider: string): string {
  return { ga4: 'Google Analytics 4', gsc: 'Google Search Console', gtm: 'Google Tag Manager', google: 'Google Ads', meta: 'Meta', tiktok: 'TikTok', microsoft: 'Microsoft', reddit: 'Reddit', apple: 'Apple Ads', snapchat: 'Snapchat', spotify: 'Spotify', pinterest: 'Pinterest', linkedin: 'LinkedIn', x: 'X Ads' }[provider] ?? provider;
}
