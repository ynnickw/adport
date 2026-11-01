'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import type { Policy } from '@adport/core';
import { Button, Checkbox, Disclosure, Input, Switch } from '@/components/controls';
import { PlanLimitModal } from '@/components/plan-limit-modal';
import { Field, Provider } from '@/components/ui';
import { InfoTooltip } from '@/components/info-tooltip';
import { planLimitFromResponse, type PlanLimitDetails } from '@/lib/cloud/plan-limit';
import { createPolicySettingsDraft, policySettingsInput, type PolicySettingsDraft } from '@/lib/policy-settings';

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
  const [draft, setDraft] = useState(() => createPolicySettingsDraft(policy, dataRetentionDays, accounts.map(account => account.accountId)));
  const [saved, setSaved] = useState(draft);
  const [message, setMessage] = useState<{ error?: string; success?: string }>({});
  const [busy, setBusy] = useState(false);
  const [planLimit, setPlanLimit] = useState<PlanLimitDetails>();
  const dirty = JSON.stringify(policySettingsInput(draft)) !== JSON.stringify(policySettingsInput(saved));
  const disabled = !canAdminister || busy;

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  function update<K extends keyof PolicySettingsDraft>(key: K, value: PolicySettingsDraft[K]) {
    setDraft(current => ({ ...current, [key]: value }));
    setMessage({});
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !canAdminister || !dirty) return;
    setBusy(true);
    setMessage({});
    try {
      const response = await fetch('/api/settings', {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ organizationId, ...policySettingsInput(draft) }),
      });
      const result = await response.json().catch(() => ({})) as { error?: string };
      const limit = planLimitFromResponse(result);
      if (limit) setPlanLimit(limit);
      else if (!response.ok) setMessage({ error: result.error ?? 'Unable to save settings.' });
      else { setMessage({ success: 'Policy saved.' }); setSaved(draft); router.refresh(); }
    } catch {
      setMessage({ error: 'Could not save the policy. Check your connection and try again.' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="form" onSubmit={(event) => void save(event)}>
      <PlanLimitModal limit={planLimit} onClose={() => setPlanLimit(undefined)} />
      <fieldset className="form" style={{ border: 0, margin: 0, padding: 0 }}>
        {!writeAccess ? <div className="policy-plan-note"><div><strong>{planName} is read only</strong><p>Your safeguards apply when write access is enabled.</p></div><Link className="button secondary small" href="/dashboard/billing">View plans</Link></div> : null}
        <section className="policy-section">
          <div className="policy-section-copy"><h3>Creation <InfoTooltip label="About paused creation">When enabled, supported new campaigns, ad groups, and ads start paused. Turning this off uses the requested status. Existing campaigns are unaffected.</InfoTooltip></h3></div>
          <div className="policy-controls">
            <div className="policy-setting-row"><label htmlFor="paused-creation">Start new campaigns and ads paused</label><Switch id="paused-creation" disabled={disabled} checked={draft.pausedCreation} onClick={() => update('pausedCreation', !draft.pausedCreation)} /></div>
          </div>
        </section>
        <section className="policy-section">
          <div className="policy-section-copy"><h3>Budget limits <InfoTooltip label="About budget limits">Turn either limit off to remove that restriction. The preview step remains required. Limits apply to each operation, not cumulative account spend.</InfoTooltip></h3></div>
          <div className="field-grid policy-controls">
            <div className="policy-limit">
              <div className="policy-setting-row"><div className="field-label"><label htmlFor="budget-change-enabled">Budget change limit</label><InfoTooltip label="About budget change limit">Limits both increases and decreases when the current budget is known. At 25%, a budget of 20 can change to between 15 and 25 in one operation.</InfoTooltip></div><Switch id="budget-change-enabled" aria-controls="budget-change-value" disabled={disabled} checked={draft.budgetChangeEnabled} onClick={() => update('budgetChangeEnabled', !draft.budgetChangeEnabled)} /></div>
              <div id="budget-change-value">{draft.budgetChangeEnabled ? <Field label="Maximum change (%)" htmlFor="max-budget-change"><Input disabled={disabled} id="max-budget-change" name="maxBudgetDeltaPct" type="number" min="0.01" step="0.01" required value={draft.budgetChange} onChange={event => update('budgetChange', event.target.value)} /></Field> : <p className="field-hint">No percentage limit</p>}</div>
            </div>
            <div className="policy-limit">
              <div className="policy-setting-row"><div className="field-label"><label htmlFor="daily-budget-enabled">Daily budget limit</label><InfoTooltip label="About daily budget limit">Caps each resulting daily budget in the ad account’s currency. A value of 100 means EUR 100 for a euro account and USD 100 for a dollar account. This is not a total spend cap.</InfoTooltip></div><Switch id="daily-budget-enabled" aria-controls="daily-budget-value" disabled={disabled} checked={draft.dailyBudgetEnabled} onClick={() => update('dailyBudgetEnabled', !draft.dailyBudgetEnabled)} /></div>
              <div id="daily-budget-value">{draft.dailyBudgetEnabled ? <Field label="Maximum daily budget" htmlFor="max-daily-budget"><Input disabled={disabled} id="max-daily-budget" name="maxDailyBudget" type="number" min="0.01" step="0.01" required value={draft.dailyBudget} onChange={event => update('dailyBudget', event.target.value)} /></Field> : <p className="field-hint">No daily budget limit</p>}</div>
            </div>
          </div>
        </section>
        <section className="policy-section protected-section">
          <div className="policy-section-copy"><h3>Read-only accounts <InfoTooltip label="About read-only accounts">Select accounts to block advertising changes while keeping read access. Account access and plan restrictions still apply.</InfoTooltip></h3></div>
          <div className="policy-controls">
            {accounts.length > 0 ? <div className="policy-account-list">
              {accounts.map((account) => {
                const protectedAccount = draft.protectedAccounts.includes(account.accountId);
                return <label className="policy-account" key={`${account.provider}:${account.accountId}`}>
                  <Checkbox disabled={disabled} name="protectedAccount" value={account.accountId} checked={protectedAccount} aria-label={`Make ${account.name} read only`} onChange={event => update('protectedAccounts', event.target.checked ? [...draft.protectedAccounts, account.accountId] : draft.protectedAccounts.filter(id => id !== account.accountId))} />
                  <Provider name={account.provider} />
                  <span className="policy-account-copy"><strong>{account.name}</strong><small>{account.accountId}{account.currency ? ` · ${account.currency}` : ''}</small></span>
                  <span className={`status ${!account.enabled || protectedAccount || !writeAccess ? 'neutral' : ''}`}>{!account.enabled ? 'Disabled' : protectedAccount || !writeAccess ? 'Read only' : 'Preview required'}</span>
                </label>;
              })}
            </div> : <div className="inline-note">Connect a platform to choose read-only accounts.</div>}
            <Disclosure label="Other account IDs"><Field label="Read-only account IDs" htmlFor="other-account-ids" help="Use this for accounts temporarily absent from the list. Separate IDs with commas."><Input disabled={disabled} id="other-account-ids" name="manualProtectedAccounts" value={draft.otherAccountIds} onChange={event => update('otherAccountIds', event.target.value)} /></Field></Disclosure>
          </div>
        </section>
        <section className="policy-section">
          <div className="policy-section-copy"><h3>Review & history <InfoTooltip label="About review and history">Choose how long previews remain valid and how long audit history is kept.</InfoTooltip></h3></div>
          <div className="field-grid policy-controls">
            <Field label="Preview lifetime (minutes)" htmlFor="approval-lifetime" help="After this time, a fresh preview is required before applying."><Input disabled={disabled} id="approval-lifetime" name="pendingTtlMinutes" type="number" min="1" step="1" value={draft.previewLifetime} onChange={event => update('previewLifetime', event.target.value)} required /></Field>
            <Field label="History retention (days)" htmlFor="data-retention" help={`${planName} includes up to ${maxRetentionDays} days. A longer history requires an upgrade.`}><Input disabled={disabled} id="data-retention" name="dataRetentionDays" type="number" min="1" max="3650" step="1" value={draft.retentionDays} onChange={event => update('retentionDays', event.target.value)} required /></Field>
          </div>
        </section>
        {canAdminister ? (
          <div className="form-actions save-bar">
            <p className={`save-state${message.error ? ' is-error' : message.success ? ' is-saved' : dirty ? ' is-dirty' : ''}`} role={message.error ? 'alert' : 'status'}>
              {message.error ?? message.success ?? (dirty ? 'Unsaved changes' : 'All changes saved')}
            </p>
            <Button type="button" className="button secondary" disabled={busy || !dirty} onClick={() => { setDraft(saved); setMessage({}); }}>Discard</Button>
            <Button className="button" disabled={busy || !dirty}>{busy ? 'Saving…' : 'Save policy'}</Button>
          </div>
        ) : <p className="inline-note">Owners and admins can change the policy.</p>}
      </fieldset>
    </form>
  );
}
