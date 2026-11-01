'use client';

import { Button, Checkbox, Input } from '@/components/controls';

import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import type { Policy } from '@adport/core';
import { PlanLimitModal } from '@/components/plan-limit-modal';
import { Field, Provider } from '@/components/ui';
import { InfoTooltip } from '@/components/info-tooltip';
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
  const [dirty, setDirty] = useState(false);
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
    try {
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
      else { setMessage({ success: 'Safety policy saved.' }); setDirty(false); router.refresh(); }
    } catch {
      setMessage({ error: 'Could not save the policy. Check your connection and try again.' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="form" onSubmit={(event) => void save(event)} onChange={() => { setDirty(true); setMessage({}); }}>
      <PlanLimitModal limit={planLimit} onClose={() => setPlanLimit(undefined)} />
      <fieldset className="form" style={{ border: 0, margin: 0, padding: 0 }}>
        {!writeAccess ? <div className="policy-plan-note"><div><strong>{planName} is read only</strong><p>Your safeguards apply when write access is enabled.</p></div><Link className="button secondary small" href="/dashboard/billing">View plans</Link></div> : null}
        <section className="policy-section">
          <div className="policy-section-copy"><h3>Approvals <InfoTooltip>The preview step is always required. Only the exact operation that was previewed can be applied.</InfoTooltip></h3></div>
          <div className="policy-controls">
            <div className="policy-always-on"><span>Preview and exact approval</span><span className="status neutral">Always on</span></div>
            <label className="check"><Checkbox disabled={!canAdminister} name="pausedCreation" defaultChecked={policy.paused_creation} /> Force newly created objects to paused</label>
          </div>
        </section>
        <section className="policy-section">
          <div className="policy-section-copy"><h3>Budget limits <InfoTooltip>Changes above either limit are rejected before they reach the advertising platform.</InfoTooltip></h3></div>
          <div className="field-grid policy-controls">
            <Field label="Max budget change (%)" htmlFor="max-budget-change" help="The largest percentage change a single operation may make to any budget."><Input disabled={!canAdminister} id="max-budget-change" name="maxBudgetDeltaPct" type="number" min="0.01" step="0.01" defaultValue={policy.max_budget_delta_pct ?? ''} placeholder="No limit" /></Field>
            <Field label="Max daily budget" htmlFor="max-daily-budget" help="In the ad account's currency. Changes above this limit are refused."><Input disabled={!canAdminister} id="max-daily-budget" name="maxDailyBudget" type="number" min="0.01" step="0.01" defaultValue={policy.max_daily_budget_micros === null || policy.max_daily_budget_micros === undefined ? '' : policy.max_daily_budget_micros / 1_000_000} placeholder="No limit" /></Field>
          </div>
        </section>
        <section className="policy-section">
          <div className="policy-section-copy"><h3>Review & history <InfoTooltip>Choose how long previews remain valid and how long audit history is kept.</InfoTooltip></h3></div>
          <div className="field-grid policy-controls">
            <Field label="Approval lifetime (minutes)" htmlFor="approval-lifetime" help="A preview expires if it is not applied within this window."><Input disabled={!canAdminister} id="approval-lifetime" name="pendingTtlMinutes" type="number" min="1" step="1" defaultValue={policy.pending_ttl_minutes} required /></Field>
            <Field label="Data retention (days)" htmlFor="data-retention" help={`${planName} includes up to ${maxRetentionDays} days. A longer history requires an upgrade.`}><Input disabled={!canAdminister} id="data-retention" name="dataRetentionDays" type="number" min="1" max="3650" step="1" defaultValue={dataRetentionDays} required /></Field>
          </div>
        </section>
        <section className="policy-section protected-section">
          <div className="policy-section-copy"><h3>Protected accounts <InfoTooltip>Selected accounts remain readable, but all advertising changes are refused.</InfoTooltip></h3></div>
          <div className="policy-controls">
            {accounts.length > 0 ? <div className="policy-account-list">
              {accounts.map((account) => (
                <label className="policy-account" key={`${account.provider}:${account.accountId}`}>
                  <Checkbox disabled={!canAdminister} name="protectedAccount" value={account.accountId} defaultChecked={policy.protected_accounts.includes(account.accountId)} />
                  <Provider name={account.provider} />
                  <span className="policy-account-copy"><strong>{account.name}</strong><small>{account.accountId}{account.currency ? ` · ${account.currency}` : ''}</small></span>
                  <span className={`status ${account.enabled ? '' : 'neutral'}`}>{account.enabled ? 'active' : 'inactive'}</span>
                </label>
              ))}
            </div> : <div className="inline-note">No accounts have been discovered yet. Connect a provider to select protected accounts by name.</div>}
            <Field label="Other account IDs" htmlFor="other-account-ids" help="Protect an account that is temporarily absent from the list. Separate IDs with commas."><Input disabled={!canAdminister} id="other-account-ids" name="manualProtectedAccounts" defaultValue={manualProtectedAccounts.join(', ')} placeholder="Comma-separated account IDs" /></Field>
          </div>
        </section>
        {canAdminister ? (
          // Sticky so the save action and its result stay in view on this long form.
          <div className="form-actions save-bar">
            <p className={`save-state${message.error ? ' is-error' : message.success ? ' is-saved' : dirty ? ' is-dirty' : ''}`} role={message.error ? 'alert' : 'status'}>
              {message.error ?? message.success ?? (dirty ? 'Unsaved changes' : 'All changes saved')}
            </p>
            <Button className="button" disabled={busy || !dirty}>{busy ? 'Saving…' : 'Save policy'}</Button>
          </div>
        ) : <p className="inline-note">Owners and admins can change the policy.</p>}
      </fieldset>
    </form>
  );
}
