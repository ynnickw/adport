'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import type { Policy } from '@adport/core';

export function PolicyForm({ organizationId, canAdminister, policy, dataRetentionDays }: {
  organizationId: string;
  canAdminister: boolean;
  policy: Policy;
  dataRetentionDays: number;
}) {
  const router = useRouter();
  const [message, setMessage] = useState<{ error?: string; success?: string }>({});
  const [busy, setBusy] = useState(false);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage({});
    const data = Object.fromEntries(new FormData(event.currentTarget).entries());
    const numberOrNull = (value: FormDataEntryValue | undefined) => value === undefined || value === '' ? null : Number(value);
    const response = await fetch('/api/settings', {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        organizationId,
        dataRetentionDays: Number(data.dataRetentionDays),
        policy: {
          require_validation: true,
          paused_creation: data.pausedCreation === 'on',
          max_budget_delta_pct: numberOrNull(data.maxBudgetDeltaPct),
          max_daily_budget_micros: numberOrNull(data.maxDailyBudgetMicros),
          protected_accounts: String(data.protectedAccounts ?? '').split(',').map((item) => item.trim()).filter(Boolean),
          pending_ttl_minutes: Number(data.pendingTtlMinutes),
        },
      }),
    });
    const result = await response.json().catch(() => ({})) as { error?: string };
    if (!response.ok) setMessage({ error: result.error ?? 'Unable to save settings.' });
    else { setMessage({ success: 'Safety policy saved.' }); router.refresh(); }
    setBusy(false);
  }

  return (
    <form className="form" onSubmit={(event) => void save(event)}>
      {message.error ? <div className="error-callout" style={{ marginBottom: 0 }}>{message.error}</div> : null}
      {message.success ? <div className="callout success">{message.success}</div> : null}
      <fieldset className="form" disabled={!canAdminister} style={{ border: 0, margin: 0, padding: 0 }}>
        <label className="check locked"><input type="checkbox" checked readOnly /> Preview and exact approval required for every write</label>
        <label className="check"><input name="pausedCreation" type="checkbox" defaultChecked={policy.paused_creation} /> Force newly created objects to paused</label>
        <div className="field-grid">
          <label className="field"><span>Max budget change (%)</span><input name="maxBudgetDeltaPct" type="number" min="0.01" step="0.01" defaultValue={policy.max_budget_delta_pct ?? ''} placeholder="No limit" /></label>
          <label className="field"><span>Max daily budget (micros)</span><input name="maxDailyBudgetMicros" type="number" min="1" step="1" defaultValue={policy.max_daily_budget_micros ?? ''} placeholder="No limit" /></label>
          <label className="field"><span>Approval lifetime (minutes)</span><input name="pendingTtlMinutes" type="number" min="1" step="1" defaultValue={policy.pending_ttl_minutes} required /></label>
          <label className="field"><span>Data retention (days)</span><input name="dataRetentionDays" type="number" min="1" max="3650" step="1" defaultValue={dataRetentionDays} required /></label>
        </div>
        <label className="field">
          <span>Protected account IDs</span>
          <input name="protectedAccounts" defaultValue={policy.protected_accounts.join(', ')} placeholder="Comma-separated; writes to these accounts are always refused" />
          <span className="field-hint">Writes targeting a protected account are rejected before any provider call.</span>
        </label>
        {canAdminister ? <div className="form-actions"><button className="button" disabled={busy}>{busy ? 'Saving…' : 'Save policy'}</button></div> : <p className="inline-note">Owners and admins can change the policy.</p>}
      </fieldset>
    </form>
  );
}
