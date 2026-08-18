'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';

interface Member { userId: string; email: string; displayName: string; role: string; }

export function TeamMembers({ organizationId, currentUserId, currentRole, members }: {
  organizationId: string;
  currentUserId: string;
  currentRole: string;
  members: Member[];
}) {
  const router = useRouter();
  const [message, setMessage] = useState<{ error?: string; success?: string }>({});
  const [busy, setBusy] = useState(false);
  const canAdminister = currentRole === 'owner' || currentRole === 'admin';

  async function call(method: 'POST' | 'PATCH' | 'DELETE', body: Record<string, unknown>, success: string) {
    setBusy(true);
    setMessage({});
    const response = await fetch('/api/members', { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ organizationId, ...body }) });
    const result = await response.json().catch(() => ({})) as { error?: string };
    if (!response.ok) setMessage({ error: result.error ?? 'The request failed.' });
    else { setMessage({ success }); router.refresh(); }
    setBusy(false);
    return response.ok;
  }

  async function invite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = Object.fromEntries(new FormData(form).entries());
    if (await call('POST', { email: data.email, role: data.role }, 'Member added or invited.')) form.reset();
  }

  return (
    <>
      {message.error ? <div className="card-body" style={{ paddingBottom: 0 }}><div className="error-callout" style={{ marginBottom: 0 }}>{message.error}</div></div> : null}
      {message.success ? <div className="card-body" style={{ paddingBottom: 0 }}><div className="callout success">{message.success}</div></div> : null}
      <div className="row-list">
        {members.map((member) => (
          <div className="row-item" key={member.userId}>
            <div>
              <strong>{member.displayName}{member.userId === currentUserId ? <span className="text-muted"> · you</span> : null}</strong>
              <div className="cell-sub">{member.email}</div>
            </div>
            <div className="row-actions">
              {canAdminister && member.role !== 'owner'
                ? <select aria-label={`Role for ${member.email}`} value={member.role} disabled={busy} onChange={(event) => void call('PATCH', { userId: member.userId, role: event.target.value }, 'Member role updated.')}>
                    {currentRole === 'owner' ? <option value="admin">Admin</option> : null}
                    <option value="member">Member</option>
                    <option value="viewer">Viewer</option>
                  </select>
                : <span className="status neutral">{member.role}</span>}
              {canAdminister && member.userId !== currentUserId && member.role !== 'owner'
                ? <button className="button danger small" disabled={busy} onClick={() => { if (window.confirm(`Remove ${member.email} from this organization?`)) void call('DELETE', { userId: member.userId }, 'Member removed.'); }}>Remove</button>
                : null}
            </div>
          </div>
        ))}
      </div>
      {canAdminister ? (
        <div className="card-body" style={{ borderTop: '1px solid var(--line-soft)' }}>
          <form className="form-row" onSubmit={(event) => void invite(event)}>
            <input name="email" type="email" required placeholder="colleague@company.com" style={{ flex: 1, minWidth: '14rem' }} aria-label="Email" />
            <select name="role" defaultValue="member" aria-label="Role">
              {currentRole === 'owner' ? <option value="admin">Admin</option> : null}
              <option value="member">Member</option>
              <option value="viewer">Viewer</option>
            </select>
            <button className="button secondary" disabled={busy}>Invite</button>
          </form>
        </div>
      ) : null}
    </>
  );
}
