'use client';

import { DashboardLink as Link } from '@/components/dashboard-navigation';
import { useEffect, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { Account } from '@adport/core';
import { Provider } from '@/components/ui';
import { accountSelectionSavedPath } from '@/lib/account-selection-path';
import { Button, Checkbox } from '@/components/controls';
import { ConnectionSteps } from '@/components/connection-steps';
import { DataCell, DataTable } from '@/components/data-table';
import { Notice } from '@/components/feedback';
import { SearchField } from '@/components/list-controls';
import { InfoTooltip } from '@/components/info-tooltip';
import { UpgradeButton } from '@/components/upgrade-button';
import { PlanLimitModal } from '@/components/plan-limit-modal';
import { planLimitFromResponse, type PlanLimitDetails } from '@/lib/cloud/plan-limit';
import { useConfirm } from '@/components/use-confirm';
import { providerResourceName, usesAdAccountSlot } from '@/lib/cloud/providers';

export interface ProviderAccountSelection {
  id: string;
  provider: string;
  accounts: Account[];
  pages?: Array<{ id: string; name: string; category?: string }>;
}

export function ProviderAccountPicker({ organizationId, selectionId, provider, accounts, initialSelectedIds, initialEnabledIds = [], maxActiveAccounts = null, organizationActiveCount = 0, pages, backHref = '/dashboard/connections', nextPath, showProgress = true }: {
  organizationId: string; selectionId: string; provider: string;
  accounts: Account[]; initialSelectedIds: string[];
  pages?: Array<{ id: string; name: string; category?: string }>;
  backHref?: string;
  nextPath?: string;
  initialEnabledIds?: string[];
  maxActiveAccounts?: number | null;
  organizationActiveCount?: number;
  showProgress?: boolean;
}) {
  const router = useRouter();
  const singleAccount = accounts.length === 1;
  const [selected, setSelected] = useState(() => new Set(initialSelectedIds.filter(id => accounts.some(account => account.id === id))));
  const [query, setQuery] = useState('');
  const [selectedPages, setSelectedPages] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState<string>();
  const [planLimit, setPlanLimit] = useState<PlanLimitDetails>();
  const [pending, startTransition] = useTransition();
  const [saveMode, setSaveMode] = useState<'enable' | 'import'>();
  const [confirm, confirmationDialog] = useConfirm();
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus({ preventScroll: true }); }, []);
  const visible = accounts.filter(account => `${account.name} ${account.id}`.toLowerCase().includes(query.trim().toLowerCase()));
  const chosenIds = singleAccount ? accounts.map(account => account.id) : [...selected];
  const chosen = new Set(chosenIds);
  const removedCount = initialSelectedIds.filter(id => !chosen.has(id)).length;
  const enabledElsewhere = organizationActiveCount - initialEnabledIds.length;
  const billable = usesAdAccountSlot(provider);
  const showCurrency = billable || accounts.some(account => Boolean(account.currency));
  const resource = providerResourceName(provider);
  const singular = providerResourceName(provider, 1);
  const header = singular[0]!.toUpperCase() + singular.slice(1);
  const exceedsLimit = billable && chosenIds.length > 0 && maxActiveAccounts !== null && enabledElsewhere + chosenIds.length > maxActiveAccounts;
  const limitMessage = `Enabling this selection would use ${enabledElsewhere + chosenIds.length} account slots. Your organization’s plan includes ${maxActiveAccounts}.`;

  async function save(enableAccess: boolean) {
    const accountIds = chosenIds;
    if (removedCount && !await confirm({
      title: `Remove ${removedCount} ${providerResourceName(provider, removedCount)} from this project?`,
      description: `Saving removes the unselected ${resource} from Adport and its assistants. It does not change anything at the platform.`,
      confirmLabel: 'Remove and save',
    })) return;
    setError(undefined);
    setSaveMode(enableAccess ? 'enable' : 'import');
    startTransition(async () => {
      try {
        const response = await fetch('/api/account-selection', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ organizationId, selectionId, accountIds, enableAccess,
            ...(provider === 'meta' && pages !== undefined ? { pageIds: [...selectedPages] } : {}),
          }),
        });
        const body = await response.json() as { error?: string; returnPath?: string };
        const limit = planLimitFromResponse(body);
        if (limit) { setPlanLimit(limit); return; }
        if (!response.ok) { setError(body.error ?? 'Could not save account selection.'); return; }
        router.replace(accountSelectionSavedPath(nextPath ?? body.returnPath ?? '/dashboard/accounts', provider, enableAccess && accountIds.length > 0));
      } catch { setError('Could not save account selection. Check your connection and try again.'); }
    });
  }

  return <div className="account-selection-step">{showProgress ? <ConnectionSteps active={pending ? 'save' : 'choose'} resources={resource} /> : null}<section className="card account-selection-card">
    {confirmationDialog}
    <PlanLimitModal limit={planLimit} onClose={() => setPlanLimit(undefined)} />
    <div className="card-head"><h2 ref={heading} tabIndex={-1}><Provider name={provider} /></h2><span className="card-note" aria-live="polite">{singleAccount ? `1 ${singular} available` : `${selected.size} of ${accounts.length} selected`}</span></div>
    {accounts.length > 2 ? <div className="account-picker-toolbar">
      {accounts.length > 6 ? <div className="account-picker-search"><SearchField aria-label={`Search ${resource}`} value={query} disabled={pending} onChange={event => setQuery(event.target.value)} placeholder={`Search ${resource} by name or ID`} /></div> : null}
      <Button type="button" className="button secondary small" disabled={pending || !visible.length} onClick={() => setSelected(current => new Set([...current, ...visible.map(account => account.id)]))}>{query.trim() ? 'Select matching' : 'Select all'}</Button>
      <Button type="button" className="button secondary small" disabled={pending || !selected.size} onClick={() => setSelected(new Set())}>Clear selection</Button>
    </div> : null}
    {error ? <Notice tone="error">{error}</Notice> : null}
    {visible.length ? <DataTable busy={pending} responsive className="account-picker-table" columns={[...(!singleAccount ? ['Add'] : []), header, ...(showCurrency ? ['Currency'] : []), 'Platform status']}>
      {visible.map(account => <tr key={account.id}>
        {!singleAccount ? <DataCell label="Add"><Checkbox aria-label={`Add ${account.name} (${account.id})`} checked={selected.has(account.id)} disabled={pending} onChange={event => {
          const checked = event.target.checked;
          setSelected(current => { const next = new Set(current); if (checked) next.add(account.id); else next.delete(account.id); return next; });
        }} /></DataCell> : null}
        <DataCell label={header} className="account-picker-identity">
          {provider === 'gsc' && account.id === account.name && account.id.startsWith('sc-domain:')
            ? <><strong>{account.name.slice('sc-domain:'.length)}</strong><div className="cell-sub">Domain property</div></>
            : <><strong>{account.name}</strong>{account.id !== account.name ? <div className="cell-sub">{account.id}</div> : null}</>}
        </DataCell>
        {showCurrency ? <DataCell label="Currency">{account.currency ?? '—'}</DataCell> : null}<DataCell label="Platform status"><span className="status neutral">{account.status ?? 'available'}</span></DataCell>
      </tr>)}
    </DataTable> : <div className="empty"><h3>{accounts.length ? `No matching ${resource}` : `No ${resource} returned`}</h3><p>{accounts.length ? 'Try another name or ID.' : `This connection returned no ${resource}. Continue without adding any, or reconnect later.`}</p></div>}
    {provider === 'meta' && pages !== undefined ? <section aria-labelledby="meta-pages-heading">
      <div className="card-head"><h2 id="meta-pages-heading">Facebook Pages</h2><span className="card-note" aria-live="polite">{selectedPages.size} of {pages.length} selected</span></div>
      <div className="account-picker-help"><span>Optional Page access</span><InfoTooltip label="About Page access">Page tools will have no access unless you select a Page. Selecting a Page allows reading; it does not link it to an ad account or publish content.</InfoTooltip></div>
      {pages.length ? <DataTable responsive columns={['Allow', 'Page', 'Category']}>
        {pages.map(page => <tr key={page.id}>
          <DataCell label="Allow"><Checkbox aria-label={`Allow Page ${page.name} (${page.id})`} checked={selectedPages.has(page.id)} disabled={pending}
            onChange={event => { const checked = event.target.checked; setSelectedPages(current => { const next = new Set(current); if (checked) next.add(page.id); else next.delete(page.id); return next; }); }} /></DataCell>
          <DataCell label="Page"><strong>{page.name}</strong><div className="cell-sub">{page.id}</div></DataCell><DataCell label="Category">{page.category ?? '—'}</DataCell>
        </tr>)}
      </DataTable> : <p className="inline-note" style={{ padding: '0 1.5rem' }}>Meta returned no Pages. To grant a Page, re-authorize Meta and use Edit settings in Facebook to review Page access.</p>}
    </section> : null}
    <div className="account-picker-footer">
      <p className="account-picker-help">{billable ? 'Enabling access does not change campaigns.' : 'Sources don’t use ad-account slots.'} <InfoTooltip label={`About enabling ${resource}`}>Importing without enabling keeps new {resource} disabled and preserves existing access.</InfoTooltip></p>
      {exceedsLimit ? <Notice>{limitMessage} Choose fewer accounts to enable them, or save this selection without enabling.</Notice> : null}
      {removedCount ? <p className="inline-note selection-removal-note">{removedCount} previously added {providerResourceName(provider, removedCount)} will be removed from this project.</p> : null}
      <div className="account-picker-actions"><Link className="button secondary" href={backHref} aria-disabled={pending} onClick={event => { if (pending) event.preventDefault(); }}>Back</Link><div className="account-picker-submit">
        {exceedsLimit ? <UpgradeButton kind="active_accounts" required={enabledElsewhere + chosenIds.length} message={limitMessage} label="Compare plans" className="button secondary" disabled={pending} /> : null}
        {chosenIds.length ? <Button type="button" className={exceedsLimit ? 'button account-picker-save' : 'button secondary'} disabled={pending} pending={pending && saveMode === 'import'} pendingLabel="Saving…" onClick={() => void save(false)}>{exceedsLimit ? 'Save without enabling' : 'Import without enabling'}</Button> : null}
        {!exceedsLimit ? <Button type="button" className="button account-picker-save" disabled={pending} pending={pending && (saveMode === 'enable' || chosenIds.length === 0)} pendingLabel="Saving…" onClick={() => void save(chosenIds.length > 0)}>{chosenIds.length ? `Add and enable ${chosenIds.length} ${providerResourceName(provider, chosenIds.length)}` : removedCount ? 'Review removals' : selectedPages.size ? 'Save Pages and continue' : `Continue without ${resource}`}</Button> : null}
      </div></div>
    </div>
  </section></div>;
}
