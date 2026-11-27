'use client';

import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { DashboardLink as Link } from '@/components/dashboard-navigation';
import { pendingSelectionPath } from '@/lib/account-selection-path';
import { Button, Switch } from '@/components/controls';
import { Select } from '@/components/select';
import { ListToolbar, SearchField } from '@/components/list-controls';
import { useToast } from '@/components/toast';
import { DataCell, DataTable } from '@/components/data-table';
import { Notice } from '@/components/feedback';
import { InfoTooltip } from '@/components/info-tooltip';
import { Empty, Provider } from '@/components/ui';
import { PlanLimitModal } from '@/components/plan-limit-modal';
import { UpgradeButton } from '@/components/upgrade-button';
import { planLimitFromResponse, type PlanLimitDetails } from '@/lib/cloud/plan-limit';
import { providerLabel, providerConnectionsPath, providerCategory, usesAdAccountSlot, type ProviderCategory } from '@/lib/cloud/providers';
import type { CloudProvider } from '@/lib/cloud/types';

export interface AccountAccessItem {
  provider: string;
  accountId: string;
  name: string;
  currency: string | null;
  status: string | null;
  enabled: boolean;
  connectionStatus?: string;
  accountSelectionId?: string | null;
  accountSelectionUnavailable?: boolean;
}

function accessState(account: AccountAccessItem): 'enabled' | 'disabled' | 'unavailable' {
  if (!account.enabled) return 'disabled';
  return account.accountSelectionId || (account.connectionStatus && account.connectionStatus !== 'connected') ? 'unavailable' : 'enabled';
}

export function AccountAccessManager({ organizationId, accounts, canManage, maxActiveAccounts, providerFilter, organizationActiveCount, setupReturnTo, category: categoryOverride }: {
  organizationId: string;
  accounts: AccountAccessItem[];
  canManage: boolean;
  maxActiveAccounts: number | null;
  providerFilter?: CloudProvider;
  organizationActiveCount?: number;
  setupReturnTo?: string;
  category?: ProviderCategory;
}) {
  const category = categoryOverride ?? (providerFilter ? providerCategory(providerFilter) : 'advertising');
  const router = useRouter();
  const [items, setItems] = useState(accounts);
  const [busy, setBusy] = useState<string>();
  const [refreshing, startRefresh] = useTransition();
  const [error, setError] = useState<string>();
  const toast = useToast();
  const [planLimit, setPlanLimit] = useState<PlanLimitDetails>();
  const [query, setQuery] = useState('');
  const [platform, setPlatform] = useState('');
  const [filter, setFilter] = useState<'all' | ReturnType<typeof accessState>>('all');
  useEffect(() => { setItems(accounts); }, [accounts]);
  const platforms = [...new Set(items.map(account => account.provider))].sort((a, b) => providerLabel(a).localeCompare(providerLabel(b)));
  const selectedPlatform = providerFilter ?? (platforms.includes(platform) ? platform : '');
  const providerAccounts = selectedPlatform ? items.filter(account => account.provider === selectedPlatform) : items;
  const noun = category === 'analytics' ? 'sources' : 'accounts';
  const counts = { all: providerAccounts.length, enabled: 0, disabled: 0, unavailable: 0 };
  for (const account of providerAccounts) counts[accessState(account)]++;
  const showSearch = items.length > 6;
  const showStatusFilter = providerAccounts.length > 6 && [counts.enabled, counts.disabled, counts.unavailable].filter(Boolean).length > 1;
  const effectiveFilter = showStatusFilter ? filter : 'all';
  const search = showSearch ? query.trim().toLowerCase() : '';
  const organizationCount = organizationActiveCount === undefined ? undefined
    : organizationActiveCount + items.filter(account => account.enabled && usesAdAccountSlot(account.provider)).length - accounts.filter(account => account.enabled && usesAdAccountSlot(account.provider)).length;
  const visible = providerAccounts.filter(account => (effectiveFilter === 'all' || accessState(account) === effectiveFilter)
    && (!search || (account.name + ' ' + account.accountId + ' ' + providerLabel(account.provider)).toLowerCase().includes(search)));
  const atLimit = category === 'advertising' && maxActiveAccounts !== null && organizationCount !== undefined && organizationCount >= maxActiveAccounts;

  async function setEnabled(account: AccountAccessItem, enabled: boolean) {
    const key = account.provider + ':' + account.accountId;
    setBusy(key); setError(undefined);
    try {
      const response = await fetch('/api/account-access', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ organizationId, provider: account.provider, accountId: account.accountId, enabled }),
      });
      const body = await response.json().catch(() => ({})) as { error?: string };
      const limit = planLimitFromResponse(body);
      if (limit) setPlanLimit(limit);
      else if (!response.ok) setError(body.error ?? 'Account access could not be updated. Please try again.');
      else {
        setItems(current => current.map(item => item.provider === account.provider && item.accountId === account.accountId ? { ...item, enabled } : item));
        toast(enabled ? `Adport access enabled for ${account.name}.` : `Adport access disabled for ${account.name}.`);
        startRefresh(() => router.refresh());
      }
    } catch {
      setError('Could not update ' + account.name + '. Check your connection and try again.');
    } finally { setBusy(undefined); }
  }

  return <section className="card account-access-card" aria-label={category === 'analytics' ? 'Analytics account access' : 'Ad account access'}>
    <PlanLimitModal limit={planLimit} onClose={() => setPlanLimit(undefined)} />
    <div className="card-head"><div className="account-access-heading"><h2>{category === 'analytics' ? 'Source access' : 'Adport access'}</h2><InfoTooltip label="About account access">{category === 'analytics' ? 'Enable the analytics and tracking sources your assistants may access. Sources do not use ad-account slots.' : 'Enabled ad accounts are available to your AI assistants and use plan slots. Disabling access only removes the account from Adport; your campaigns keep running.'}</InfoTooltip></div><div className="account-access-counts">{category === 'analytics' ? null : <Link href="/dashboard/billing#usage">{organizationCount === undefined ? 'Organization allowance: ' + (maxActiveAccounts ?? 'unlimited') + ' accounts' : organizationCount + ' / ' + (maxActiveAccounts ?? 'unlimited') + ' organization slots'}</Link>}</div></div>
    {showSearch || (!providerFilter && platforms.length > 1) ? <ListToolbar divided>
      {showSearch ? <SearchField value={query} onChange={event => setQuery(event.target.value)} placeholder="Search name, ID, or platform" aria-label={category === 'analytics' ? 'Search analytics sources' : 'Search ad accounts'} /> : null}
      {!providerFilter && platforms.length > 1 ? <Select aria-label="Platform" value={selectedPlatform} onValueChange={value => { setPlatform(value); setFilter('all'); }}
        options={[{ value: '', label: 'All platforms' }, ...platforms.map(value => ({ value, label: providerLabel(value) }))]} /> : null}
      {showStatusFilter ? <Select aria-label="Access status" value={filter}
        onValueChange={value => setFilter(value as typeof filter)}
        options={([['all', 'Any access'], ['enabled', 'Enabled'], ['disabled', 'Disabled'], ['unavailable', 'Unavailable']] as const)
          .filter(([id]) => counts[id] > 0 || filter === id).map(([value, label]) => ({ value, label }))} /> : null}
    </ListToolbar> : null}
    {atLimit && canManage ? <div className="account-limit-note"><span>{organizationCount} of {maxActiveAccounts} account slots in use across this organization. Disable an account to free a slot.</span> <UpgradeButton kind="active_accounts" required={(organizationCount ?? 0) + 1} message={`Your organization uses ${organizationCount} account slots. Its plan includes ${maxActiveAccounts}.`} /></div> : null}
    {!canManage ? <p className="account-limit-note">An owner or admin can change account access.</p> : null}
    {error ? <Notice tone="error">{error}</Notice> : null}
    {visible.length ? <DataTable responsive className="account-access-table" columns={[category === 'analytics' ? 'Source' : 'Account', 'Platform', 'Adport access']}>
      {visible.map(account => {
        const key = account.provider + ':' + account.accountId;
        const needsSelection = Boolean(account.accountSelectionId);
        const needsReconnect = Boolean(account.connectionStatus && account.connectionStatus !== 'connected');
        const needsRestart = needsSelection && account.accountSelectionUnavailable;
        const recovery = needsReconnect ? 'Reconnect platform' : needsRestart ? 'Restart selection' : needsSelection ? `Choose ${noun}` : '';
        return <tr key={key} data-enabled={account.enabled} data-access-state={accessState(account)}>
          <DataCell label={category === 'analytics' ? 'Source' : 'Account'}><strong>{account.name}</strong><div className="cell-sub">{account.accountId}{account.currency ? ' · ' + account.currency : ''}</div></DataCell>
          <DataCell label="Platform"><Provider name={account.provider} /></DataCell>
          <DataCell label="Adport access"><div className="account-access-state">
            {canManage ? <Switch checked={account.enabled} aria-label={'Adport access for ' + account.name} disabled={Boolean(busy) || refreshing || (!account.enabled && (needsSelection || needsReconnect))} onClick={() => void setEnabled(account, !account.enabled)} /> : <span className={'access-dot' + (account.enabled ? ' enabled' : '')} aria-hidden="true" />}
            <span>{busy === key ? 'Updating…' : { enabled: 'Enabled', disabled: 'Disabled', unavailable: 'Unavailable' }[accessState(account)]}</span>
            <InfoTooltip label={'Platform status for ' + account.name}>{account.status ?? 'Available at the platform'}. Adport access is managed separately from the account's status at {providerLabel(account.provider)}.</InfoTooltip>
          </div>
          {recovery ? canManage ? <Link className="account-access-fix" href={needsReconnect || needsRestart ? providerConnectionsPath(account.provider) : pendingSelectionPath(account.accountSelectionId!, account.provider, setupReturnTo)}>{recovery} ↗</Link> : <span className="cell-sub">{needsReconnect ? 'Connection needs attention' : 'Selection incomplete'}</span> : null}</DataCell>
        </tr>;
      })}
    </DataTable> : <Empty heading="h3" title={providerAccounts.length ? `No matching ${noun}` : `No ${noun} added yet`}
      copy={providerAccounts.length ? 'Try another search or access filter.' : `There are no ${noun} to manage here.`}>
      {providerAccounts.length ? <Button className="button secondary small" type="button" onClick={() => { setQuery(''); setFilter('all'); setPlatform(''); }}>Clear filters</Button> : null}
    </Empty>}
  </section>;
}
