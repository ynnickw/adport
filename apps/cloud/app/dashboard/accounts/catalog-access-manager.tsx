'use client';

import { useEffect, useRef, useState } from 'react';
import { Button, Disclosure, Input } from '@/components/controls';
import { Dialog } from '@/components/dialog';
import { Select } from '@/components/select';
import { LoadingStatus, Notice } from '@/components/feedback';

type Provider = 'tiktok' | 'reddit';
const platformName = { tiktok: 'TikTok', reddit: 'Reddit' };
const businessPattern = (provider: Provider) => provider === 'reddit' ? '[a-fA-F0-9]{8}-(?:[a-fA-F0-9]{4}-){3}[a-fA-F0-9]{12}' : '[0-9]{1,30}';
const validBusiness = (value: string, provider: Provider) => new RegExp('^' + businessPattern(provider) + '$').test(value);
const validCatalog = (value: string, provider: Provider) => (provider === 'reddit' ? /^[A-Za-z0-9_-]{1,256}$/ : /^\d{1,30}$/).test(value);
type Account = { accountId: string; name: string; ready: boolean };
type Grant = { scope: { accountId: string; businessId: string; resourceId: string; kind: string }; mode: string; hash: string };
type Arguments = { organizationId: string; account_id: string; bc_id?: string; provider?: Provider; business_id?: string; catalog_id?: string; resource_kind?: 'catalog' | 'catalog_creation' | 'catalog_migration'; acknowledge_source_ownership?: true; acknowledge_shared_effects?: true; mode: string; expected_access_hash: string };
type Review = { arguments: Arguments; result: { pending_operation_id: string; preview: { review: { fields: Array<{ label: string; before?: unknown; after: unknown }>; subject?: string } } } };
async function loadGrants(url: string, signal?: AbortSignal, provider: Provider = 'tiktok') {
  const response = await fetch(url, { signal, cache: 'no-store' }), data = await response.json();
  if (!response.ok || !Array.isArray(data.grants)) throw new Error(typeof data.error === 'string' ? data.error : 'Could not load catalog access.');
  const requested = new URLSearchParams(url.split('?')[1]);
  if (data.organizationId !== requested.get('organizationId') || data.account_id !== requested.get('account_id') || provider === 'reddit' && data.provider !== 'reddit' || data.grants.some((value: Grant) => value.scope?.accountId !== data.account_id || !(provider === 'tiktok' ? ['catalog', 'catalog_creation', 'catalog_migration'] : ['catalog', 'catalog_creation']).includes(value.scope.kind) || !validBusiness(value.scope.businessId, provider) || !validCatalog(value.scope.resourceId, provider) || !(value.scope.kind === 'catalog_creation' ? value.mode === 'create' && value.scope.resourceId === value.scope.businessId : value.scope.kind === 'catalog_migration' ? value.mode === 'migrate' : ['read', 'write'].includes(value.mode)) || !/^[a-f0-9]{64}$/.test(value.hash))) throw new Error('The catalog access response did not match this project and advertiser.');
  return data.grants as Grant[];
}

export function CatalogAccessManager({ organizationId, projectName, accounts, provider = 'tiktok' }: { organizationId: string; projectName: string; accounts: Account[]; provider?: Provider }) {
  const [open, setOpen] = useState(false), [selected, setSelected] = useState(accounts[0]?.accountId ?? '');
  const account = accounts.find(value => value.accountId === selected) ?? accounts[0];
  if (!account) return null;
  return <Disclosure label={platformName[provider] + ' catalog access'} className="card catalog-access-control">
    <div className="catalog-access-launch">
      <p className="inline-note">Choose the catalogs agents can use in {projectName}.</p>
      {accounts.length > 1 ? <div className="catalog-field">Advertiser<Select aria-label="Advertiser" value={account.accountId} onValueChange={setSelected}
        options={accounts.map(value => ({ value: value.accountId, label: value.name }))} /></div> : null}
      <Button type="button" className="button secondary small" onClick={() => setOpen(true)}>Manage catalog access</Button>
    </div>
    {open ? <CatalogAccessDialog key={organizationId + ':' + provider + ':' + account.accountId} provider={provider} organizationId={organizationId} projectName={projectName} account={account} onClose={() => setOpen(false)} /> : null}
  </Disclosure>;
}

function CatalogAccessDialog({ organizationId, projectName, account, onClose, provider }: { organizationId: string; projectName: string; account: Account; onClose: () => void; provider: Provider }) {
  const [grants, setGrants] = useState<Grant[]>([]), [limit, setLimit] = useState(10), [bc, setBc] = useState(''), [catalog, setCatalog] = useState(''), [mode, setMode] = useState(account.ready ? 'read' : 'none'), [kind, setKind] = useState<'catalog' | 'catalog_creation' | 'catalog_migration'>('catalog');
  const [review, setReview] = useState<Review>(), [busy, setBusy] = useState(false), [loading, setLoading] = useState(true), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [ownership, setOwnership] = useState(false), [sharedEffects, setSharedEffects] = useState(false);
  const flight = useRef(false);
  const listUrl = '/api/catalog-access?' + new URLSearchParams({ organizationId, account_id: account.accountId, ...(provider === 'reddit' ? { provider: 'reddit' } : {}) });
  useEffect(() => {
    const controller = new AbortController();let active = true;
    void loadGrants(listUrl, controller.signal, provider).then(rows => { if (active) setGrants(rows); }).catch(reason => { if (active) setError(reason instanceof Error ? reason.message : 'Could not load catalog access.'); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false;controller.abort(); };
  }, [listUrl, provider]);
  const change = () => { setReview(undefined);setError('');setNotice(''); };
  const resourceOptions = [{ value: 'catalog', label: 'Existing catalog' }, { value: 'catalog_creation', label: 'New catalogs' },
    ...(provider === 'tiktok' ? [{ value: 'catalog_migration', label: 'Transfer a catalog' }] : [])];
  const accessOptions = (kind === 'catalog_creation' ? [{ value: 'create', label: 'Create and manage new catalogs' }]
    : kind === 'catalog_migration' ? [{ value: 'migrate', label: 'Transfer this catalog only' }]
    : [{ value: 'read', label: 'Read' }, { value: 'write', label: 'Read and write' }])
    .map(option => ({ ...option, disabled: !account.ready }));
  async function submit(apply = false) {
    if (flight.current || apply && !review || !apply && kind === 'catalog_migration' && mode !== 'none' && (!ownership || !sharedEffects)) return;
    flight.current = true;
    setBusy(true);setError('');setNotice('');
    try {
      const args = apply ? { ...review!.arguments, pending_operation_id: review!.result.pending_operation_id } : { organizationId, account_id: account.accountId, ...(provider === 'reddit' ? { provider: 'reddit', business_id: bc } : { bc_id: bc }), ...(kind === 'catalog_creation' ? { resource_kind: kind } : { catalog_id: catalog, ...(kind === 'catalog_migration' ? { resource_kind: kind, ...(mode !== 'none' ? { acknowledge_source_ownership: true, acknowledge_shared_effects: true } : {}) } : {}) }), mode };
      const response = await fetch('/api/catalog-access', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(args) }), data = await response.json();
      if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : 'Could not confirm this access change.');
      if (apply) {
        if (data.result?.applied !== true) throw new Error('The access change was not confirmed.');
        setGrants(await loadGrants(listUrl, undefined, provider));setReview(undefined);setNotice('Catalog access updated.');
      } else {
        if (typeof data.result?.pending_operation_id !== 'string' || !Array.isArray(data.result?.preview?.review?.fields) || data.arguments?.organizationId !== organizationId || data.arguments?.account_id !== account.accountId || (provider === 'reddit' ? data.arguments?.provider !== 'reddit' || data.arguments?.business_id !== bc || data.arguments?.bc_id !== undefined : data.arguments?.bc_id !== bc || data.arguments?.business_id !== undefined) || (kind === 'catalog_creation' ? data.arguments?.resource_kind !== kind || data.arguments?.catalog_id !== undefined : data.arguments?.catalog_id !== catalog || (kind === 'catalog_migration' ? data.arguments?.resource_kind !== kind || mode !== 'none' && (data.arguments?.acknowledge_source_ownership !== true || data.arguments?.acknowledge_shared_effects !== true) : data.arguments?.resource_kind && data.arguments.resource_kind !== 'catalog')) || data.arguments?.mode !== mode || !/^[a-f0-9]{64}$/.test(data.arguments?.expected_access_hash ?? '')) throw new Error('The access preview could not be verified.');
        setReview(data as Review);
      }
    } catch (reason) { setReview(undefined);setError((reason instanceof Error ? reason.message : 'The request could not be confirmed.') + (apply ? ' Refresh current access before trying again.' : '')); }
    finally { flight.current = false;setBusy(false); }
  }
  return <Dialog title="Catalog access" onClose={() => { if (!busy) onClose(); }} className="catalog-access-dialog" portal>
    <p className="dialog-description">{projectName} · {account.name}</p>
    <form onSubmit={event => { event.preventDefault();void submit(); }}>
      <div className="catalog-access-fields">
        <label>{provider === 'reddit' ? 'Business ID' : 'Business Center ID'}<Input data-autofocus inputMode={provider === 'reddit' ? 'text' : 'numeric'} required pattern={businessPattern(provider)} value={bc} disabled={busy} onChange={event => { setBc(provider === 'reddit' ? event.target.value.trim().toLowerCase() : event.target.value.trim());setOwnership(false);setSharedEffects(false);change(); }} /></label>
        <div className="catalog-field">Resource<Select aria-label="Resource" value={kind} disabled={busy} options={resourceOptions} onValueChange={value => {
          const next = value as typeof kind;setKind(next);setCatalog('');setOwnership(false);setSharedEffects(false);
          setMode(account.ready ? next === 'catalog_creation' ? 'create' : next === 'catalog_migration' ? 'migrate' : 'read' : 'none');change();
        }} /></div>
        {kind !== 'catalog_creation' ? <label>Catalog ID<Input inputMode={provider === 'reddit' ? 'text' : 'numeric'} required pattern={provider === 'reddit' ? '[A-Za-z0-9_-]{1,256}' : '[0-9]{1,30}'} value={catalog} disabled={busy} onChange={event => { setCatalog(event.target.value.trim());setOwnership(false);setSharedEffects(false);change(); }} /></label> : null}
        <div className="catalog-field">Project access<Select aria-label="Project access" value={mode} disabled={busy}
          options={[...accessOptions, { value: 'none', label: 'Revoke access' }]}
          onValueChange={value => { setMode(value);setOwnership(false);setSharedEffects(false);change(); }} /></div>
      </div>
      {kind === 'catalog_creation' ? <p className="inline-note">Allows creation in this Business and management of verified new catalog IDs. Existing catalogs are excluded. Revoking this delegation keeps independent catalog grants in place.</p> : null}
      {kind === 'catalog_migration' && mode !== 'none' ? <fieldset disabled={busy}><legend>Source ownership and transfer</legend><label><input type="checkbox" checked={ownership} onChange={event => { setOwnership(event.target.checked);change(); }} />I own catalog {catalog || '…'} under advertiser {account.accountId}. Adport cannot independently verify the source catalog; TikTok checks ownership on transfer.</label><label><input type="checkbox" checked={sharedEffects} onChange={event => { setSharedEffects(event.target.checked);change(); }} />I authorize transferring this entire catalog and its contents to Business Center {bc || '…'}, including effects on shared ads and users. This does not grant ongoing project read/write access.</label></fieldset> : null}
      {review ? <div className="catalog-access-review" aria-label="Access change preview"><strong>{review.result.preview.review.subject}</strong><dl>{review.result.preview.review.fields.map(field => <div key={field.label}><dt>{field.label}</dt><dd>{field.before !== undefined ? <><span>{String(field.before)}</span> → </> : null}<strong>{String(field.after)}</strong></dd></div>)}</dl><p className="inline-note">Catalog changes can affect other ads or accounts that reuse it. This grants Adport access; {platformName[provider]} permissions remain in place.</p></div> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}{notice ? <Notice tone="success">{notice}</Notice> : null}
      {!account.ready ? <p className="inline-note">Access can be revoked now. Enable the advertiser and reconnect the platform before granting access.</p> : null}
      <div className="dialog-actions"><Button type="button" className="button secondary" disabled={busy} onClick={onClose}>Close</Button>{review ? <Button type="button" className="button" pending={busy} pendingLabel="Applying…" disabled={!account.ready && review.arguments.mode !== 'none'} onClick={() => void submit(true)}>Confirm access</Button> : <Button type="submit" className="button" pending={busy} pendingLabel="Preparing…" disabled={!validBusiness(bc, provider) || kind !== 'catalog_creation' && !validCatalog(catalog, provider) || kind === 'catalog_migration' && mode !== 'none' && (!ownership || !sharedEffects) || !account.ready && mode !== 'none'}>Review access</Button>}</div>
    </form>
    <div className="catalog-access-list"><div className="card-head"><h3>Current access</h3><Button type="button" className="button secondary small" disabled={busy || loading} onClick={() => { setLoading(true);change();void loadGrants(listUrl, undefined, provider).then(setGrants).catch(reason => setError(reason instanceof Error ? reason.message : 'Could not refresh access.')).finally(() => setLoading(false)); }}>Refresh</Button></div>
      {loading ? <LoadingStatus>Loading access…</LoadingStatus> : grants.length ? <><ul>{grants.slice(0, limit).map(grant => <li key={grant.scope.businessId + ':' + grant.scope.kind + ':' + grant.scope.resourceId}><Button type="button" disabled={busy} onClick={() => { setBc(grant.scope.businessId);setKind(grant.scope.kind as 'catalog' | 'catalog_creation' | 'catalog_migration');setCatalog(grant.scope.kind !== 'catalog_creation' ? grant.scope.resourceId : '');setOwnership(false);setSharedEffects(false);setMode(grant.mode);change(); }}><span>{grant.scope.kind === 'catalog_creation' ? 'New catalogs' : grant.scope.kind === 'catalog_migration' ? 'Transfer catalog ' + grant.scope.resourceId : 'Catalog ' + grant.scope.resourceId}<small>{provider === 'reddit' ? 'Business' : 'Business Center'} {grant.scope.businessId}</small></span><span>{grant.mode === 'write' ? 'Read and write' : grant.mode === 'create' ? 'Create and manage new' : grant.mode === 'migrate' ? 'Transfer only' : 'Read'}</span></Button></li>)}</ul>{grants.length > limit ? <Button type="button" className="button secondary small" onClick={() => setLimit(value => value + 10)}>Load more</Button> : null}</> : <p className="inline-note">No catalogs selected for this advertiser.</p>}
    </div>
  </Dialog>;
}
