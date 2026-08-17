'use client';

import { useEffect, useState } from 'react';

interface KeySummary { id: string; name: string; keyPrefix: string; createdAt: string; lastUsedAt: string | null; }

export function ApiKeyManager({ organizationId }: { organizationId: string }) {
  const [keys, setKeys] = useState<KeySummary[]>([]);
  const [createdKey, setCreatedKey] = useState<string>();
  const [error, setError] = useState<string>();

  async function load() {
    const response = await fetch(`/api/api-keys?organization_id=${organizationId}`, { cache: 'no-store' });
    const data = await response.json() as { keys?: KeySummary[]; error?: string };
    if (!response.ok) setError(data.error ?? 'Unable to load API keys.');
    else setKeys(data.keys ?? []);
  }

  useEffect(() => { void load(); }, [organizationId]);

  async function create() {
    setError(undefined);
    const response = await fetch('/api/api-keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ organization_id: organizationId, name: 'Local agent', scopes: ['tools:read', 'tools:write'] }),
    });
    const data = await response.json() as { key?: string; error?: string };
    if (!response.ok || !data.key) setError(data.error ?? 'Unable to create API key.');
    else { setCreatedKey(data.key); await load(); }
  }

  async function revoke(id: string) {
    if (!window.confirm('Revoke this API key? Existing clients will immediately lose access.')) return;
    const response = await fetch(`/api/api-keys/${id}?organization_id=${organizationId}`, { method: 'DELETE' });
    if (!response.ok) setError('Unable to revoke API key.');
    else await load();
  }

  return (
    <section className="card">
      <div className="card-header"><div><h2>Agent API keys</h2><span className="muted">Bearer credentials for remote MCP and REST.</span></div><button className="button secondary" onClick={create}>Create key</button></div>
      {createdKey ? <><p className="success">Copy this key now. It is shown only once.</p><div className="code">{createdKey}</div></> : null}
      {error ? <p className="error">{error}</p> : null}
      {keys.length === 0 ? <p className="muted">No API keys yet.</p> : keys.map((key) => (
        <div className="card-header" key={key.id}><div><strong>{key.name}</strong><div className="muted">{key.keyPrefix}…</div></div><button className="button danger" onClick={() => revoke(key.id)}>Revoke</button></div>
      ))}
    </section>
  );
}
