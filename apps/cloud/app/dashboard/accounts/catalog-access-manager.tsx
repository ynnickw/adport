'use client';

import { useEffect, useRef, useState } from 'react';
import { Button, Disclosure, Input } from '@/components/controls';
import { Dialog } from '@/components/dialog';

type Account = { accountId: string; name: string; ready: boolean };
type Grant = { scope: { accountId: string; businessId: string; resourceId: string; kind: string }; mode: string; hash: string };
type Arguments = { organizationId: string; account_id: string; bc_id: string; catalog_id?: string; resource_kind?: 'catalog' | 'catalog_creation'; mode: string; expected_access_hash: string };
type Review = { arguments: Arguments; result: { pending_operation_id: string; preview: { review: { fields: Array<{ label: string; before?: unknown; after: unknown }>; subject?: string } } } };
async function loadGrants(url: string, signal?: AbortSignal) {
  const response = await fetch(url, { signal, cache: 'no-store' }), data = await response.json();
  if (!response.ok || !Array.isArray(data.grants)) throw new Error(typeof data.error === 'string' ? data.error : 'Could not load catalog access.');
  const requested = new URLSearchParams(url.split('?')[1]);
  if (data.organizationId !== requested.get('organizationId') || data.account_id !== requested.get('account_id') || data.grants.some((value: Grant) => value.scope?.accountId !== data.account_id || !['catalog', 'catalog_creation'].includes(value.scope.kind) || !/^\d{1,30}$/.test(value.scope.businessId) || !/^\d{1,30}$/.test(value.scope.resourceId) || !(value.scope.kind === 'catalog_creation' ? value.mode === 'create' && value.scope.resourceId === value.scope.businessId : ['read', 'write'].includes(value.mode)) || !/^[a-f0-9]{64}$/.test(value.hash))) throw new Error('The catalog access response did not match this project and advertiser.');
  return data.grants as Grant[];
}

export function CatalogAccessManager({ organizationId, projectName, accounts }: { organizationId: string; projectName: string; accounts: Account[] }) {
  const [open, setOpen] = useState(false), [selected, setSelected] = useState(accounts[0]?.accountId ?? '');
  const account = accounts.find(value => value.accountId === selected) ?? accounts[0];
  if (!account) return null;
  return <Disclosure label="TikTok catalog access" className="card catalog-access-control">
    <div className="catalog-access-launch">
      <p className="inline-note">Choose the Business Center catalogs agents can use in {projectName}.</p>
      {accounts.length > 1 ? <label>Advertiser<select value={account.accountId} onChange={event => setSelected(event.target.value)}>{accounts.map(value => <option key={value.accountId} value={value.accountId}>{value.name}</option>)}</select></label> : null}
      <Button type="button" className="button secondary small" onClick={() => setOpen(true)}>Manage catalog access</Button>
    </div>
    {open ? <CatalogAccessDialog key={organizationId + ':' + account.accountId} organizationId={organizationId} projectName={projectName} account={account} onClose={() => setOpen(false)} /> : null}
  </Disclosure>;
}

function CatalogAccessDialog({ organizationId, projectName, account, onClose }: { organizationId: string; projectName: string; account: Account; onClose: () => void }) {
  const [grants, setGrants] = useState<Grant[]>([]), [limit, setLimit] = useState(10), [bc, setBc] = useState(''), [catalog, setCatalog] = useState(''), [mode, setMode] = useState(account.ready ? 'read' : 'none'), [kind, setKind] = useState<'catalog' | 'catalog_creation'>('catalog');
  const [review, setReview] = useState<Review>(), [busy, setBusy] = useState(false), [loading, setLoading] = useState(true), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const flight = useRef(false);
  const listUrl = '/api/catalog-access?' + new URLSearchParams({ organizationId, account_id: account.accountId });
  useEffect(() => {
    const controller = new AbortController();let active = true;
    void loadGrants(listUrl, controller.signal).then(rows => { if (active) setGrants(rows); }).catch(reason => { if (active) setError(reason instanceof Error ? reason.message : 'Could not load catalog access.'); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false;controller.abort(); };
  }, [listUrl]);
  const change = () => { setReview(undefined);setError('');setNotice(''); };
  async function submit(apply = false) {
    if (flight.current || apply && !review) return;
    flight.current = true;
    setBusy(true);setError('');setNotice('');
    try {
      const args = apply ? { ...review!.arguments, pending_operation_id: review!.result.pending_operation_id } : { organizationId, account_id: account.accountId, bc_id: bc, ...(kind === 'catalog_creation' ? { resource_kind: kind } : { catalog_id: catalog }), mode };
      const response = await fetch('/api/catalog-access', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(args) }), data = await response.json();
      if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : 'Could not confirm this access change.');
      if (apply) {
        if (data.result?.applied !== true) throw new Error('The access change was not confirmed.');
        setGrants(await loadGrants(listUrl));setReview(undefined);setNotice('Catalog access updated.');
      } else {
        if (typeof data.result?.pending_operation_id !== 'string' || !Array.isArray(data.result?.preview?.review?.fields) || data.arguments?.organizationId !== organizationId || data.arguments?.account_id !== account.accountId || data.arguments?.bc_id !== bc || (kind === 'catalog_creation' ? data.arguments?.resource_kind !== kind || data.arguments?.catalog_id !== undefined : data.arguments?.catalog_id !== catalog || data.arguments?.resource_kind && data.arguments.resource_kind !== 'catalog') || data.arguments?.mode !== mode || !/^[a-f0-9]{64}$/.test(data.arguments?.expected_access_hash ?? '')) throw new Error('The access preview could not be verified.');
        setReview(data as Review);
      }
    } catch (reason) { setReview(undefined);setError((reason instanceof Error ? reason.message : 'The request could not be confirmed.') + (apply ? ' Refresh current access before trying again.' : '')); }
    finally { flight.current = false;setBusy(false); }
  }
  return <Dialog title="Catalog access" onClose={() => { if (!busy) onClose(); }} className="catalog-access-dialog" portal>
    <p className="dialog-description">{projectName} · {account.name}</p>
    <form onSubmit={event => { event.preventDefault();void submit(); }}>
      <div className="catalog-access-fields">
        <label>Business Center ID<Input data-autofocus inputMode="numeric" required pattern="[0-9]{1,30}" value={bc} disabled={busy} onChange={event => { setBc(event.target.value.trim());change(); }} /></label>
        <label>Resource<select value={kind} disabled={busy} onChange={event => { const next = event.target.value as 'catalog' | 'catalog_creation';setKind(next);setCatalog('');setMode(account.ready ? next === 'catalog_creation' ? 'create' : 'read' : 'none');change(); }}><option value="catalog">Existing catalog</option><option value="catalog_creation">New catalogs</option></select></label>
        {kind === 'catalog' ? <label>Catalog ID<Input inputMode="numeric" required pattern="[0-9]{1,30}" value={catalog} disabled={busy} onChange={event => { setCatalog(event.target.value.trim());change(); }} /></label> : null}
        <label>Project access<select value={mode} disabled={busy} onChange={event => { setMode(event.target.value);change(); }}>{kind === 'catalog_creation' ? <option value="create" disabled={!account.ready}>Create and manage new catalogs</option> : <><option value="read" disabled={!account.ready}>Read</option><option value="write" disabled={!account.ready}>Read and write</option></>}<option value="none">Revoke access</option></select></label>
      </div>
      {kind === 'catalog_creation' ? <p className="inline-note">Allows creation in this Business Center and management of verified new catalog IDs. Existing catalogs are excluded. Revoking this delegation keeps independent catalog grants in place.</p> : null}
      {review ? <div className="catalog-access-review" aria-label="Access change preview"><strong>{review.result.preview.review.subject}</strong><dl>{review.result.preview.review.fields.map(field => <div key={field.label}><dt>{field.label}</dt><dd>{field.before !== undefined ? <><span>{String(field.before)}</span> → </> : null}<strong>{String(field.after)}</strong></dd></div>)}</dl><p className="inline-note">Catalog changes can affect other ads or accounts that reuse it. This grants Adport access; TikTok permissions remain in place.</p></div> : null}
      {error ? <p role="alert" className="error-callout">{error}</p> : null}{notice ? <p role="status">{notice}</p> : null}
      {!account.ready ? <p className="inline-note">Access can be revoked now. Enable the advertiser and reconnect TikTok before granting access.</p> : null}
      <div className="dialog-actions"><Button type="button" className="button secondary" disabled={busy} onClick={onClose}>Close</Button>{review ? <Button type="button" className="button" disabled={busy || !account.ready && review.arguments.mode !== 'none'} onClick={() => void submit(true)}>{busy ? 'Applying…' : 'Confirm access'}</Button> : <Button type="submit" className="button" disabled={busy || !/^\d{1,30}$/.test(bc) || kind === 'catalog' && !/^\d{1,30}$/.test(catalog) || !account.ready && mode !== 'none'}>{busy ? 'Preparing…' : 'Review access'}</Button>}</div>
    </form>
    <div className="catalog-access-list"><div className="card-head"><h3>Current access</h3><Button type="button" className="button secondary small" disabled={busy || loading} onClick={() => { setLoading(true);change();void loadGrants(listUrl).then(setGrants).catch(reason => setError(reason instanceof Error ? reason.message : 'Could not refresh access.')).finally(() => setLoading(false)); }}>Refresh</Button></div>
      {loading ? <p className="inline-note" role="status">Loading…</p> : grants.length ? <><ul>{grants.slice(0, limit).map(grant => <li key={grant.scope.businessId + ':' + grant.scope.kind + ':' + grant.scope.resourceId}><Button type="button" disabled={busy} onClick={() => { setBc(grant.scope.businessId);setKind(grant.scope.kind as 'catalog' | 'catalog_creation');setCatalog(grant.scope.kind === 'catalog' ? grant.scope.resourceId : '');setMode(grant.mode);change(); }}><span>{grant.scope.kind === 'catalog_creation' ? 'New catalogs' : 'Catalog ' + grant.scope.resourceId}<small>Business Center {grant.scope.businessId}</small></span><span>{grant.mode === 'write' ? 'Read and write' : grant.mode === 'create' ? 'Create and manage new' : 'Read'}</span></Button></li>)}</ul>{grants.length > limit ? <Button type="button" className="button secondary small" onClick={() => setLimit(value => value + 10)}>Load more</Button> : null}</> : <p className="inline-note">No catalogs selected for this advertiser.</p>}
    </div>
  </Dialog>;
}
