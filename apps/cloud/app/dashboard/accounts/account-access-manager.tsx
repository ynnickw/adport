'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { Provider } from '@/components/ui';

export interface AccountAccessItem {
  provider: string;
  accountId: string;
  name: string;
  currency: string | null;
  status: string | null;
  enabled: boolean;
}

export function AccountAccessManager({ organizationId, accounts, canManage, maxActiveAccounts }: {
  organizationId: string;
  accounts: AccountAccessItem[];
  canManage: boolean;
  maxActiveAccounts: number | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string>();
  const activeCount = accounts.filter((account) => account.enabled).length;

  function setEnabled(account: AccountAccessItem, enabled: boolean) {
    setError(undefined);
    startTransition(async () => {
      const response = await fetch('/api/account-access', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ organizationId, provider: account.provider, accountId: account.accountId, enabled }),
      });
      const body = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) setError(body.error ?? 'Account access could not be updated.');
      else router.refresh();
    });
  }

  return (
    <section className="card">
      <div className="card-head">
        <h2>Agent account access</h2>
        <span className="card-note">{activeCount} / {maxActiveAccounts ?? 'unlimited'} active</span>
      </div>
      {error ? <div className="error-callout" role="alert">{error}</div> : null}
      <div className="table-wrap"><table>
        <thead><tr><th>Account</th><th>Provider</th><th>Currency</th><th>Status</th><th>Agent access</th></tr></thead>
        <tbody>
          {accounts.map((account) => (
            <tr key={`${account.provider}:${account.accountId}`}>
              <td><strong>{account.name}</strong><div className="cell-sub">{account.accountId}</div></td>
              <td><Provider name={account.provider} /></td>
              <td>{account.currency ?? '—'}</td>
              <td><span className="status neutral">{account.status ?? 'available'}</span></td>
              <td>
                {canManage ? (
                  <button className={`button small ${account.enabled ? 'secondary' : ''}`} type="button" disabled={pending}
                    onClick={() => setEnabled(account, !account.enabled)}>
                    {account.enabled ? 'Disable' : 'Enable'}
                  </button>
                ) : <span className={`status ${account.enabled ? '' : 'neutral'}`}>{account.enabled ? 'active' : 'inactive'}</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table></div>
    </section>
  );
}
