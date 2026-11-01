'use client';

import { Button, Input } from '@/components/controls';

import { useEffect, useState } from 'react';
import { formatDate, formatRelative } from '@/components/ui';
import { InfoTooltip } from '@/components/info-tooltip';
import { useConfirm } from '@/components/use-confirm';

interface KeySummary { id: string; name: string; keyPrefix: string; createdAt: string; lastUsedAt: string | null; }
interface OAuthGrantSummary {
  clientId: string;
  userId: string;
  clientName: string;
  clientUri: string | null;
  scopes: string[];
  resource: string;
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
  status: 'active' | 'rotated' | 'revoked' | 'expired';
}

export function ApiKeyManager({ organizationId, canManage }: { organizationId: string; canManage: boolean }) {
  const [keys, setKeys] = useState<KeySummary[]>();
  const [oauthGrants, setOauthGrants] = useState<OAuthGrantSummary[]>();
  const [createdKey, setCreatedKey] = useState<string>();
  const [name, setName] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [confirm, confirmationDialog] = useConfirm();

  async function load() {
    setError(undefined);
    try {
      const response = await fetch(`/api/api-keys?organization_id=${organizationId}`, { cache: 'no-store' });
      const data = await response.json().catch(() => ({})) as { keys?: KeySummary[]; oauthGrants?: OAuthGrantSummary[]; error?: string };
      if (!response.ok) setError(data.error ?? 'Unable to load API keys.');
      else {
        setKeys(data.keys ?? []);
        setOauthGrants(data.oauthGrants ?? []);
      }
    } catch { setError('Could not load agent access. Check your connection and try again.'); }
  }

  useEffect(() => { void load(); }, [organizationId]);

  async function create() {
    setBusy(true);
    setError(undefined);
    try {
      const response = await fetch('/api/api-keys', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ organization_id: organizationId, name: name.trim() || 'Agent key', scopes: ['tools:read', 'tools:write'] }),
      });
      const data = await response.json().catch(() => ({})) as { key?: string; error?: string };
      if (!response.ok || !data.key) setError(data.error ?? 'Unable to create API key.');
      else { setCreatedKey(data.key); setName(''); await load(); }
    } catch {
      setError('Could not create the key. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string) {
    if (!await confirm({ title: 'Revoke API key?', description: 'Connected agents lose access immediately.', confirmLabel: 'Revoke key' })) return;
    setBusy(true); setError(undefined);
    try {
      const response = await fetch(`/api/api-keys/${id}?organization_id=${organizationId}`, { method: 'DELETE' });
      if (!response.ok) setError('Unable to revoke API key.');
      else await load();
    } catch { setError('Could not revoke the key. Check your connection and try again.'); }
    finally { setBusy(false); }
  }

  return (
    <>
      {confirmationDialog}
      {createdKey ? (
        <div className="card-body" style={{ paddingBottom: 0 }}>
          <div className="callout success" role="status">Copy this key now. It is shown only once.</div>
          <div className="code secret-reveal">{createdKey}</div>
        </div>
      ) : null}
      {error ? <div className="card-body" style={{ paddingBottom: 0 }}><div className="error-callout" role="alert" style={{ marginBottom: 0 }}>{error} <Button type="button" className="button secondary small" disabled={busy} onClick={() => void load()}>Retry list</Button></div></div> : null}
      <div className="row-list">
        {!error && (keys === undefined || oauthGrants === undefined) ? <div className="row-item"><span className="inline-note">Loading agent access…</span></div> : null}
        {oauthGrants?.map((grant) => (
          <div className="row-item" key={`${grant.clientId}:${grant.userId}:${grant.resource}`}>
            <div>
              <div className="agent-identity"><strong>{grant.clientName}</strong><span className={`status${grant.status === 'active' ? '' : ' neutral'}`}>{grant.status}</span><InfoTooltip label={`Connection details for ${grant.clientName}`}>Requested scopes: {grant.scopes.join(', ')}. Authorized {formatDate(grant.createdAt)}. Refresh grant expires {formatDate(grant.expiresAt)}.</InfoTooltip></div>
              <div className="cell-sub">
                OAuth · {grant.lastUsedAt ? `Used ${formatRelative(grant.lastUsedAt)}` : 'Not used yet'}
              </div>
            </div>
          </div>
        ))}
        {keys?.length === 0 && oauthGrants?.length === 0 ? <div className="row-item"><span className="inline-note">No agent credentials yet. OAuth-capable MCP clients create a grant during authorization; manual REST clients can use a key below.</span></div> : null}
        {keys?.map((key) => (
          <div className="row-item" key={key.id}>
            <div>
              <strong>{key.name}</strong>
              <div className="cell-sub">{key.keyPrefix}… · created {formatDate(key.createdAt)} · {key.lastUsedAt ? `last used ${formatDate(key.lastUsedAt)}` : 'never used'}</div>
            </div>
            {canManage ? <Button className="button danger small" disabled={busy} onClick={() => void revoke(key.id)}>Revoke</Button> : null}
          </div>
        ))}
      </div>
      {canManage ? (
        <div className="card-body" style={{ borderTop: '1px solid var(--line-soft)' }}>
          <div className="form-row">
            <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="Key name, e.g. Claude Desktop" aria-label="Key name" style={{ flex: 1, minWidth: '14rem' }} />
            <Button className="button" disabled={busy} onClick={() => void create()}>{busy ? 'Creating…' : 'Create key'}</Button>
          </div>
        </div>
      ) : null}
    </>
  );
}
