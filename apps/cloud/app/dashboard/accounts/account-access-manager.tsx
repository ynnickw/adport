'use client';

import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Button, Input, Switch } from '@/components/controls';
import { InfoTooltip } from '@/components/info-tooltip';
import { Provider } from '@/components/ui';
import { PlanLimitModal } from '@/components/plan-limit-modal';
import { planLimitFromResponse, type PlanLimitDetails } from '@/lib/cloud/plan-limit';
import { providerLabel } from '@/lib/cloud/providers';
import type { OAuthProvider } from '@/lib/cloud/types';

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

export function AccountAccessManager({ organizationId, accounts, canManage, maxActiveAccounts, providerFilter, organizationActiveCount }: {
  organizationId: string;
  accounts: AccountAccessItem[];
  canManage: boolean;
  maxActiveAccounts: number | null;
  providerFilter?: OAuthProvider;
  organizationActiveCount?: number;
}) {
  const router = useRouter();
  const [items, setItems] = useState(accounts);
  const [busy, setBusy] = useState<string>();
  const [refreshing, startRefresh] = useTransition();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [planLimit, setPlanLimit] = useState<PlanLimitDetails>();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<'all' | 'enabled' | 'disabled'>('all');
  useEffect(() => { setItems(accounts); }, [accounts]);
  const providerAccounts = providerFilter ? items.filter(account => account.provider === providerFilter) : items;
  const activeCount = providerAccounts.filter(account => account.enabled).length;
  const organizationCount = organizationActiveCount === undefined ? undefined
    : organizationActiveCount + items.filter(account => account.enabled).length - accounts.filter(account => account.enabled).length;
  const visible = providerAccounts.filter(account => (filter === 'all' || account.enabled === (filter === 'enabled'))
    && (account.name + ' ' + account.accountId + ' ' + providerLabel(account.provider)).toLowerCase().includes(query.trim().toLowerCase()));
  const atLimit = maxActiveAccounts !== null && organizationCount !== undefined && organizationCount >= maxActiveAccounts;

  async function setEnabled(account: AccountAccessItem, enabled: boolean) {
    const key = account.provider + ':' + account.accountId;
    setBusy(key); setError(undefined); setNotice(undefined);
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
        setNotice(account.name + ': Adport access ' + (enabled ? 'enabled.' : 'disabled. Campaigns keep running.'));
        startRefresh(() => router.refresh());
      }
    } catch {
      setError('Could not update ' + account.name + '. Check your connection and try again.');
    } finally { setBusy(undefined); }
  }

  return <section className="card account-access-card" aria-label="Ad account access">
    <PlanLimitModal limit={planLimit} onClose={() => setPlanLimit(undefined)} />
    <div className="card-head"><div className="account-access-heading"><h2>Adport access</h2><InfoTooltip label="About account access">Enabled accounts are available in reports and connected AI clients. Disabling access only removes the account from Adport; your campaigns keep running. Only enabled accounts use plan slots.</InfoTooltip></div><div className="account-access-counts"><span className="card-note">{activeCount} of {providerAccounts.length} enabled in this project</span><Link href="/dashboard/billing#usage">{organizationCount === undefined ? 'Organization allowance: ' + (maxActiveAccounts ?? 'unlimited') + ' accounts' : organizationCount + ' / ' + (maxActiveAccounts ?? 'unlimited') + ' organization slots'}</Link></div></div>
    <div className="account-access-toolbar">
      <Input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search name, ID, or platform" aria-label="Search ad accounts" />
      <div className="filter-tabs" role="group" aria-label="Filter account access">
        {(['all', 'enabled', 'disabled'] as const).map(value => <Button type="button" key={value} aria-pressed={filter === value} onClick={() => setFilter(value)}>{value === 'all' ? 'All' : value === 'enabled' ? 'Enabled' : 'Disabled'} <span>{value === 'all' ? providerAccounts.length : value === 'enabled' ? activeCount : providerAccounts.length - activeCount}</span></Button>)}
      </div>
    </div>
    {atLimit && canManage ? <div className="account-limit-note">All {maxActiveAccounts} organization account slots are in use. Disable an account to free a slot, or <Link href="/dashboard/billing?intent=active_accounts">compare plans</Link>.</div> : null}
    {!canManage ? <p className="account-limit-note">An owner or admin can change account access.</p> : null}
    {error ? <div className="error-callout" role="alert">{error}</div> : null}
    {notice ? <p className="account-access-notice" role="status">{notice}</p> : null}
    {visible.length ? <div className="table-wrap"><table className="stack-on-mobile account-access-table">
      <thead><tr><th>Account</th><th>Platform</th><th>Adport access</th></tr></thead>
      <tbody>{visible.map(account => {
        const key = account.provider + ':' + account.accountId;
        const needsSelection = Boolean(account.accountSelectionId);
        const needsReconnect = Boolean(account.connectionStatus && account.connectionStatus !== 'connected');
        return <tr key={key} data-enabled={account.enabled}>
          <td data-label="Account"><strong>{account.name}</strong><div className="cell-sub">{account.accountId}{account.currency ? ' · ' + account.currency : ''}</div></td>
          <td data-label="Platform"><Provider name={account.provider} /></td>
          <td data-label="Adport access"><div className="account-access-state">
            {canManage ? <Switch checked={account.enabled} aria-label={'Adport access for ' + account.name} disabled={Boolean(busy) || refreshing || (!account.enabled && (needsSelection || needsReconnect))} onClick={() => void setEnabled(account, !account.enabled)} /> : <span className={'access-dot' + (account.enabled ? ' enabled' : '')} aria-hidden="true" />}
            <span>{busy === key ? 'Updating…' : account.enabled ? 'Enabled' : 'Disabled'}</span>
            <InfoTooltip label={'Platform status for ' + account.name}>{account.status ?? 'Available at the platform'}. Adport access is managed separately from the account's status at {providerLabel(account.provider)}.</InfoTooltip>
          </div>
          {needsSelection ? <Link className="account-access-fix" href={account.accountSelectionUnavailable ? '/dashboard/connections#platform-' + account.provider : '/account-selection?selection_id=' + account.accountSelectionId}>{account.accountSelectionUnavailable ? 'Restart account selection ↗' : 'Finish account selection ↗'}</Link> : needsReconnect ? <Link className="account-access-fix" href={'/dashboard/connections#platform-' + account.provider}>Reconnect platform ↗</Link> : null}</td>
        </tr>;
      })}</tbody>
    </table></div> : <div className="empty"><h3>{providerAccounts.length ? 'No matching accounts' : providerFilter ? 'No ' + providerLabel(providerFilter) + ' accounts added' : 'No accounts added yet'}</h3><p>{providerAccounts.length ? 'Try another search or access filter.' : canManage ? 'Connect a platform, choose your accounts, then enable access here.' : 'Ask a project owner or admin to add accounts.'}</p>{providerAccounts.length ? <Button className="button secondary small" type="button" onClick={() => { setQuery(''); setFilter('all'); }}>Clear filters</Button> : canManage ? <Link className="button secondary" href="/dashboard/connections">Add accounts</Link> : null}</div>}
  </section>;
}
