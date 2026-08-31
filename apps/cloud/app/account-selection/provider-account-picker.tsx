'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { Account } from '@adport/core';
import { Provider } from '@/components/ui';
import { safeReturnPath } from '@/lib/return-path';

export function ProviderAccountPicker({ organizationId, selectionId, provider, accounts, initialSelectedIds }: {
  organizationId: string; selectionId: string; provider: string;
  accounts: Account[]; initialSelectedIds: string[];
}) {
  const router = useRouter();
  const singleAccount = accounts.length === 1;
  const [selected, setSelected] = useState(() => new Set(initialSelectedIds.filter(id => accounts.some(account => account.id === id))));
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string>();
  const [pending, startTransition] = useTransition();
  const visible = accounts.filter(account => `${account.name} ${account.id}`.toLowerCase().includes(query.trim().toLowerCase()));

  function save(accountIds = [...selected]) {
    setError(undefined);
    startTransition(async () => {
      try {
        const response = await fetch('/api/account-selection', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ organizationId, selectionId, accountIds }),
        });
        const body = await response.json() as { error?: string; returnPath?: string };
        if (!response.ok) { setError(body.error ?? 'Could not save account selection.'); return; }
        router.replace(safeReturnPath(body.returnPath ?? '/dashboard/accounts'));
        router.refresh();
      } catch { setError('Could not save account selection. Check your connection and try again.'); }
    });
  }

  return <section className="card">
    <div className="card-head"><h2><Provider name={provider} /></h2><span className="card-note" aria-live="polite">{singleAccount ? '1 account available' : `${selected.size} of ${accounts.length} selected`}</span></div>
    {!singleAccount && accounts.length > 0 ? <div className="account-picker-toolbar">
      <label className="account-picker-search">Search accounts<input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Account name or ID" /></label>
      <button type="button" className="button secondary small" disabled={pending || !accounts.length} onClick={() => setSelected(new Set(accounts.map(account => account.id)))}>Select all</button>
      <button type="button" className="button secondary small" disabled={pending || !selected.size} onClick={() => setSelected(new Set())}>Clear selection</button>
    </div> : null}
    {error ? <div role="alert" className="error-callout">{error}</div> : null}
    {visible.length ? <div className="table-wrap"><table>
      <thead><tr>{!singleAccount ? <th>Add</th> : null}<th>Account</th><th>Currency</th><th>Status</th></tr></thead>
      <tbody>{visible.map(account => <tr key={account.id}>
        {!singleAccount ? <td><input type="checkbox" aria-label={`Add ${account.name} (${account.id})`} checked={selected.has(account.id)} disabled={pending} onChange={event => {
          const checked = event.target.checked;
          setSelected(current => { const next = new Set(current); if (checked) next.add(account.id); else next.delete(account.id); return next; });
        }} /></td> : null}
        <td><strong>{account.name}</strong><div className="cell-sub">{account.id}</div></td>
        <td>{account.currency ?? '—'}</td><td><span className="status neutral">{account.status ?? 'available'}</span></td>
      </tr>)}</tbody>
    </table></div> : <div className="empty"><h3>{accounts.length ? 'No matching accounts' : 'No ad accounts returned'}</h3><p>{accounts.length ? 'Try another name or account ID.' : 'The provider did not return any ad accounts for this authorization. You can finish without adding accounts and re-authorize later.'}</p></div>}
    <div className="account-picker-footer">
      <p className="inline-note">{singleAccount ? 'Confirm below to add this account.' : 'Only selected accounts will be saved.'} Newly added accounts stay inactive until you enable agent access in Accounts. Existing active selections remain active.</p>
      {!singleAccount && !selected.size && accounts.length ? <p className="inline-note">Saving with nothing selected removes this provider’s accounts from Adport, without changing them at the provider.</p> : null}
      <button type="button" className="button" disabled={pending} onClick={() => save(singleAccount ? accounts.map(account => account.id) : [...selected])}>{pending ? 'Saving…' : singleAccount ? 'Add account' : selected.size ? `Save ${selected.size} selected account${selected.size === 1 ? '' : 's'}` : 'Continue without accounts'}</button>
    </div>
  </section>;
}
