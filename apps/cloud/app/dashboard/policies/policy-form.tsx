'use client';

import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import type { Policy } from '@adport/core';
import { PlanLimitModal } from '@/components/plan-limit-modal';
import { Provider } from '@/components/ui';
import { planLimitFromResponse, type PlanLimitDetails } from '@/lib/cloud/plan-limit';

interface PolicyAccount {
  provider: string;
  accountId: string;
  name: string;
  currency: string | null;
  status: string | null;
  enabled: boolean;
}

export function PolicyForm({ organizationId, canAdminister, policy, dataRetentionDays, planName, maxRetentionDays, writeAccess, accounts }: {
  organizationId: string;
  canAdminister: boolean;
  policy: Policy;
  dataRetentionDays: number;
  planName: string;
  maxRetentionDays: number;
  writeAccess: boolean;
  accounts: PolicyAccount[];
}) {
  const router = useRouter();
  const [message, setMessage] = useState<{ error?: string; success?: string }>({});
  const [busy, setBusy] = useState(false);
  const [planLimit, setPlanLimit] = useState<PlanLimitDetails>();
  const discoveredAccountIds = new Set(accounts.map((account) => account.accountId));
  const manualProtectedAccounts = policy.protected_accounts.filter((accountId) => !discoveredAccountIds.has(accountId));

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage({});
    const formData = new FormData(event.currentTarget);
    const data = Object.fromEntries(formData.entries());
    const numberOrNull = (value: FormDataEntryValue | undefined) => value === undefined || value === '' ? null : Number(value);
    const maxDailyBudget = numberOrNull(data.maxDailyBudget);
    const response = await fetch('/api/settings', {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        organizationId,
        dataRetentionDays: Number(data.dataRetentionDays),
        policy: {
          require_validation: true,
          paused_creation: data.pausedCreation === 'on',
          max_budget_delta_pct: numberOrNull(data.maxBudgetDeltaPct),
          max_daily_budget_micros: maxDailyBudget === null ? null : Math.round(maxDailyBudget * 1_000_000),
          protected_accounts: [...new Set([
            ...formData.getAll('protectedAccount').map(String),
            ...String(data.manualProtectedAccounts ?? '').split(',').map((item) => item.trim()).filter(Boolean),
          ])],
          pending_ttl_minutes: Number(data.pendingTtlMinutes),
        },
      }),
    });
    const result = await response.json().catch(() => ({})) as { error?: string };
    const limit = planLimitFromResponse(result);
    if (limit) setPlanLimit(limit);
    else if (!response.ok) setMessage({ error: result.error ?? 'Unable to save settings.' });
    else { setMessage({ success: 'Safety policy saved.' }); router.refresh(); }
    setBusy(false);
  }

  return (
    <form className="form" onSubmit={(event) => void save(event)}>
      <PlanLimitModal limit={planLimit} onClose={() => setPlanLimit(undefined)} />
      {message.error ? <div className="error-callout" style={{ marginBottom: 0 }}>{message.error}</div> : null}
      {message.success ? <div className="callout success">{message.success}</div> : null}
      <fieldset className="form" disabled={!canAdminister} style={{ border: 0, margin: 0, padding: 0 }}>
        {!writeAccess ? <div className="policy-plan-note"><div><strong>{planName} is read only</strong><p>Your safeguards are saved now and become active automatically when write access is enabled.</p></div><Link className="button secondary small" href="/dashboard/billing">Compare plans</Link></div> : null}
        <section className="policy-section">
          <div className="policy-section-copy"><span className="plan-kicker">Approval guard</span><h3>Control how changes reach providers</h3><p>The validation step cannot be disabled. Adport applies only the exact operation that was previewed.</p></div>
          <div className="policy-controls">
            <div><label className="check locked"><input type="checkbox" checked readOnly /> Preview and exact approval required</label><p className="field-hint policy-indent">Structural and always on for every write.</p></div>
            <label className="check"><input name="pausedCreation" type="checkbox" defaultChecked={policy.paused_creation} /> Force newly created objects to paused</label>
          </div>
        </section>
        <section className="policy-section">
          <div className="policy-section-copy"><span className="plan-kicker">Budget boundaries</span><h3>Cap financial impact</h3><p>Requests outside either ceiling are rejected before the provider applies them.</p></div>
          <div className="field-grid policy-controls">
            <label className="field">
              <span>Max budget change (%)</span>
              <input name="maxBudgetDeltaPct" type="number" min="0.01" step="0.01" defaultValue={policy.max_budget_delta_pct ?? ''} placeholder="No limit" />
              <span className="field-hint">The largest change a single write may make to any budget.</span>
            </label>
            <label className="field">
              <span>Max daily budget</span>
              <input name="maxDailyBudget" type="number" min="0.01" step="0.01" defaultValue={policy.max_daily_budget_micros === null || policy.max_daily_budget_micros === undefined ? '' : policy.max_daily_budget_micros / 1_000_000} placeholder="No limit" />
              <span className="field-hint">In the ad account&apos;s currency. Writes above this ceiling are refused.</span>
            </label>
          </div>
        </section>
        <section className="policy-section">
          <div className="policy-section-copy"><span className="plan-kicker">Approval & evidence</span><h3>Set the review window</h3><p>Short approvals reduce stale changes; retention controls how long audit evidence remains available.</p></div>
          <div className="field-grid policy-controls">
            <label className="field">
              <span>Approval lifetime (minutes)</span>
              <input name="pendingTtlMinutes" type="number" min="1" step="1" defaultValue={policy.pending_ttl_minutes} required />
              <span className="field-hint">A previewed write expires if it is not applied within this window.</span>
            </label>
            <label className="field">
              <span>Data retention (days)</span>
              <input name="dataRetentionDays" type="number" min="1" max="3650" step="1" defaultValue={dataRetentionDays} required />
              <span className="field-hint">{planName} includes up to {maxRetentionDays} days. Choosing more opens upgrade options.</span>
            </label>
          </div>
        </section>
        <section className="policy-section protected-section">
          <div className="policy-section-copy"><span className="plan-kicker">Protected accounts</span><h3>Make selected accounts read only</h3><p>Every write targeting a protected account is refused before any provider call. Reads continue normally.</p></div>
          <div className="policy-controls">
            {accounts.length > 0 ? <div className="policy-account-list">
              {accounts.map((account) => (
                <label className="policy-account" key={`${account.provider}:${account.accountId}`}>
                  <input name="protectedAccount" type="checkbox" value={account.accountId} defaultChecked={policy.protected_accounts.includes(account.accountId)} />
                  <Provider name={account.provider} />
                  <span className="policy-account-copy"><strong>{account.name}</strong><small>{account.accountId}{account.currency ? ` · ${account.currency}` : ''}</small></span>
                  <span className={`status ${account.enabled ? '' : 'neutral'}`}>{account.enabled ? 'active' : 'inactive'}</span>
                </label>
              ))}
            </div> : <div className="inline-note">No accounts have been discovered yet. Connect a provider to select protected accounts by name.</div>}
            <label className="field">
              <span>Other account IDs</span>
              <input name="manualProtectedAccounts" defaultValue={manualProtectedAccounts.join(', ')} placeholder="Comma-separated account IDs" />
              <span className="field-hint">Use this for an account that is temporarily absent from discovery.</span>
            </label>
          </div>
        </section>
        {canAdminister ? <div className="form-actions"><button className="button" disabled={busy}>{busy ? 'Saving…' : 'Save policy'}</button></div> : <p className="inline-note">Owners and admins can change the policy.</p>}
      </fieldset>
    </form>
  );
}
