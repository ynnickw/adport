'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import type { Policy } from '@adport/core';

interface Member { userId: string; email: string; displayName: string; role: string; }

export function TeamSettings({ organizationId, currentUserId, currentRole, members, policy, dataRetentionDays }: {
  organizationId: string;
  currentUserId: string;
  currentRole: string;
  members: Member[];
  policy: Policy;
  dataRetentionDays: number;
}) {
  const router = useRouter();
  const [message, setMessage] = useState<{ error?: string; success?: string }>({});
  const [busy, setBusy] = useState(false);
  const canAdminister = currentRole === 'owner' || currentRole === 'admin';

  async function invite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    const form = event.currentTarget;
    const data = Object.fromEntries(new FormData(form).entries());
    const response = await fetch('/api/members', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ organizationId, email: data.email, role: data.role }),
    });
    const result = await response.json() as { error?: string };
    if (!response.ok) setMessage({ error: result.error ?? 'Unable to invite member.' });
    else { form.reset(); setMessage({ success: 'Member added or invited.' }); router.refresh(); }
    setBusy(false);
  }

  async function changeRole(userId: string, role: string) {
    setBusy(true);
    const response = await fetch('/api/members', {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ organizationId, userId, role }),
    });
    const result = await response.json() as { error?: string };
    if (!response.ok) setMessage({ error: result.error ?? 'Unable to change role.' });
    else { setMessage({ success: 'Member role updated.' }); router.refresh(); }
    setBusy(false);
  }

  async function removeMember(userId: string) {
    if (!window.confirm('Remove this member from the organization?')) return;
    setBusy(true);
    const response = await fetch(`/api/members?organization_id=${organizationId}&user_id=${userId}`, { method: 'DELETE' });
    const result = await response.json() as { error?: string };
    if (!response.ok) setMessage({ error: result.error ?? 'Unable to remove member.' });
    else { setMessage({ success: 'Member removed.' }); router.refresh(); }
    setBusy(false);
  }

  async function savePolicy(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
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
    const result = await response.json() as { error?: string };
    if (!response.ok) setMessage({ error: result.error ?? 'Unable to save settings.' });
    else { setMessage({ success: 'Safety policy saved.' }); router.refresh(); }
    setBusy(false);
  }

  return (
    <section className="card full">
      <div className="card-header"><div><h2>Team and safety policy</h2><span className="muted">Tenant roles, mandatory preview/apply controls, and retention.</span></div></div>
      {message.error ? <p className="error">{message.error}</p> : null}
      {message.success ? <p className="success">{message.success}</p> : null}
      <div className="settings-grid">
        <div>
          <h3>Members</h3>
          <div className="member-list">
            {members.map((member) => (
              <div className="member-row" key={member.userId}>
                <div><strong>{member.displayName}</strong><div className="muted small">{member.email}{member.userId === currentUserId ? ' · you' : ''}</div></div>
                <div className="actions">
                  {canAdminister && member.role !== 'owner'
                    ? <select aria-label={`Role for ${member.email}`} value={member.role} disabled={busy} onChange={(event) => void changeRole(member.userId, event.target.value)}>
                        {currentRole === 'owner' ? <option value="admin">Admin</option> : null}
                        <option value="member">Member</option><option value="viewer">Viewer</option>
                      </select>
                    : <span className="muted small">{member.role}</span>}
                  {canAdminister && member.userId !== currentUserId && member.role !== 'owner'
                    ? <button className="button danger" disabled={busy} onClick={() => void removeMember(member.userId)}>Remove</button>
                    : null}
                </div>
              </div>
            ))}
          </div>
          {canAdminister ? <form className="stack compact" onSubmit={(event) => void invite(event)}>
            <label>Email<input name="email" type="email" required /></label>
            <label>Role<select name="role" defaultValue="member">{currentRole === 'owner' ? <option value="admin">Admin</option> : null}<option value="member">Member</option><option value="viewer">Viewer</option></select></label>
            <button className="button secondary" disabled={busy}>Invite member</button>
          </form> : null}
        </div>
        <div>
          <h3>Write policy</h3>
          <form className="stack compact" onSubmit={(event) => void savePolicy(event)}>
            <label className="checkbox"><input type="checkbox" checked readOnly /> Preview and exact approval required</label>
            <label className="checkbox"><input name="pausedCreation" type="checkbox" defaultChecked={policy.paused_creation} /> Force new objects to paused</label>
            <label>Maximum budget change (%)<input name="maxBudgetDeltaPct" type="number" min="0.01" step="0.01" defaultValue={policy.max_budget_delta_pct ?? ''} /></label>
            <label>Maximum daily budget (micros)<input name="maxDailyBudgetMicros" type="number" min="1" step="1" defaultValue={policy.max_daily_budget_micros ?? ''} /></label>
            <label>Protected account IDs<input name="protectedAccounts" defaultValue={policy.protected_accounts.join(', ')} /></label>
            <label>Approval lifetime (minutes)<input name="pendingTtlMinutes" type="number" min="1" step="1" defaultValue={policy.pending_ttl_minutes} required /></label>
            <label>Data retention (days)<input name="dataRetentionDays" type="number" min="1" max="3650" step="1" defaultValue={dataRetentionDays} required /></label>
            {canAdminister ? <button className="button secondary" disabled={busy}>Save settings</button> : null}
          </form>
        </div>
      </div>
    </section>
  );
}
