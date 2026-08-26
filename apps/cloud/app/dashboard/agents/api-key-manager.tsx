'use client';

import { useEffect, useState } from 'react';
import { formatDate } from '@/components/ui';

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

  async function load() {
    const response = await fetch(`/api/api-keys?organization_id=${organizationId}`, { cache: 'no-store' });
    const data = await response.json().catch(() => ({})) as { keys?: KeySummary[]; oauthGrants?: OAuthGrantSummary[]; error?: string };
    if (!response.ok) setError(data.error ?? 'Unable to load API keys.');
    else {
      setKeys(data.keys ?? []);
      setOauthGrants(data.oauthGrants ?? []);
    }
  }

  useEffect(() => { void load(); }, [organizationId]);

  async function create() {
    setBusy(true);
    setError(undefined);
    const response = await fetch('/api/api-keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ organization_id: organizationId, name: name.trim() || 'Agent key', scopes: ['tools:read', 'tools:write'] }),
    });
    const data = await response.json().catch(() => ({})) as { key?: string; error?: string };
    if (!response.ok || !data.key) setError(data.error ?? 'Unable to create API key.');
    else { setCreatedKey(data.key); setName(''); await load(); }
    setBusy(false);
  }

  async function revoke(id: string) {
    if (!window.confirm('Revoke this API key? Connected agents lose access immediately.')) return;
    const response = await fetch(`/api/api-keys/${id}?organization_id=${organizationId}`, { method: 'DELETE' });
    if (!response.ok) setError('Unable to revoke API key.');
    else await load();
  }

  return (
    <>
      {createdKey ? (
        <div className="card-body" style={{ paddingBottom: 0 }}>
          <div className="callout success">Copy this key now — it is shown only once and stored as a hash.</div>
          <div className="code secret-reveal">{createdKey}</div>
        </div>
      ) : null}
      {error ? <div className="card-body" style={{ paddingBottom: 0 }}><div className="error-callout" style={{ marginBottom: 0 }}>{error}</div></div> : null}
      <div className="row-list">
        {keys === undefined || oauthGrants === undefined ? <div className="row-item"><span className="inline-note">Loading credentials…</span></div> : null}
        {oauthGrants?.map((grant) => (
          <div className="row-item" key={`${grant.clientId}:${grant.userId}:${grant.resource}`}>
            <div>
              <strong>{grant.clientName}</strong> <span className="status">MCP OAuth · {grant.status}</span>
              <div className="cell-sub">
                {grant.scopes.join(', ')} · authorized {formatDate(grant.createdAt)} · {grant.lastUsedAt ? `last used ${formatDate(grant.lastUsedAt)}` : 'not used yet'} · refresh grant expires {formatDate(grant.expiresAt)}
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
            {canManage ? <button className="button danger small" onClick={() => void revoke(key.id)}>Revoke</button> : null}
          </div>
        ))}
      </div>
      {canManage ? (
        <div className="card-body" style={{ borderTop: '1px solid var(--line-soft)' }}>
          <div className="form-row">
            <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Key name, e.g. Claude Desktop" aria-label="Key name" style={{ flex: 1, minWidth: '14rem' }} />
            <button className="button" disabled={busy} onClick={() => void create()}>{busy ? 'Creating…' : 'Create key'}</button>
          </div>
        </div>
      ) : null}
    </>
  );
}
