'use client';

import { useEffect, useRef, useState } from 'react';
import type { MediaAsset } from '@adport/core';
import { Provider } from '@/components/ui';
import { LibraryDialog } from './library-dialog';
import { mediaAction, type Preview } from './media-client';
import styles from './assets.module.css';

type Field = { key: string; label: string; schema: { type?: string; enum?: string[]; const?: unknown; default?: unknown } };
type Destination = { provider: string; account_id: string; account_name: string; available: boolean; reason?: string; stage?: 'prepare' | 'upload'; tool?: string; arguments?: Record<string, unknown>; ready?: boolean; fields?: Field[]; note?: string };
type Plan = { destinations: Destination[]; errors: Array<{ provider: string; message: string }> };
type Job = { key: string; asset: MediaAsset; destination: Destination; parameters: Record<string, unknown>; preview?: Preview; state: 'details' | 'review' | 'accepted' | 'failed' | 'unavailable'; message?: string; ids?: string[] };

export function AssetDistribution({ projectId, assets, libraryAssets, onChange, onClose }: { projectId: string; assets: MediaAsset[]; libraryAssets: MediaAsset[]; onChange(): void; onClose(): void }) {
  const [accounts, setAccounts] = useState<Destination[]>([]), [selected, setSelected] = useState<Set<string>>(new Set()), [jobs, setJobs] = useState<Job[]>([]), [busy, setBusy] = useState(false), [loading, setLoading] = useState(true), [error, setError] = useState('');
  const lock = useRef(false), sourceId = assets[0]!.id;
  const keyFor = (destination: Destination) => `${destination.provider}:${destination.account_id}`;
  useEffect(() => {
    let alive = true;
    mediaAction<Plan>(projectId, 'media_distribution_plan', { media_id: sourceId }).then(result => { if (alive) { setAccounts(result.destinations); if (result.errors.length) setError(result.errors.map(value => `${value.provider}: ${value.message}`).join(' ')); } }).catch(reason => { if (alive) setError(reason instanceof Error ? reason.message : 'Channel accounts could not be loaded.'); }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [projectId, sourceId]);
  function update(key: string, change: Partial<Job>) { setJobs(current => current.map(job => job.key === key ? { ...job, ...change } : job)); }
  async function prepare(job: Job): Promise<Job> {
    try {
      const result = await mediaAction<Plan>(projectId, 'media_distribution_plan', { media_id: job.asset.id, provider: job.destination.provider, account_id: job.destination.account_id, parameters: job.parameters });
      const destination = result.destinations[0];
      if (!destination?.available || !destination.tool || !destination.arguments) return { ...job, state: 'unavailable', message: destination?.reason ?? result.errors[0]?.message ?? 'This destination is unavailable.' };
      if (!destination.ready) return { ...job, destination, state: 'details', message: undefined, preview: undefined };
      const preview = await mediaAction<Preview>(projectId, destination.tool, destination.arguments);
      if (preview.status !== 'pending_validation' || !preview.pending_operation_id) throw new Error('The channel did not return an approval preview.');
      return { ...job, destination, preview, state: 'review', message: undefined };
    } catch (reason) { return { ...job, state: 'failed', preview: undefined, message: reason instanceof Error ? reason.message : 'Preview failed. No upload was requested.' }; }
  }
  async function start() {
    if (!selected.size || selected.size * assets.length > 50) { setError('Choose up to 50 file and destination pairs for one batch.'); return; }
    setBusy(true); setError('');
    const next: Job[] = assets.flatMap(asset => accounts.filter(value => selected.has(keyFor(value))).map(destination => ({ key: `${asset.id}:${keyFor(destination)}`, asset, destination, parameters: {}, state: 'details' as const })));
    setJobs(next);
    for (const job of next) update(job.key, await prepare(job));
    setBusy(false);
  }
  async function prepareDetails() {
    setBusy(true); for (const job of jobs.filter(value => value.state === 'details')) update(job.key, await prepare(job)); setBusy(false);
  }
  async function apply() {
    if (busy || lock.current) return; lock.current = true; setBusy(true); setError('');
    for (const job of jobs.filter(value => value.state === 'review' && value.preview && value.destination.tool && value.destination.arguments)) {
      // Consume each token at most once in this UI, including unknown network outcomes.
      update(job.key, { state: 'failed', preview: undefined, message: 'Upload in progress. If interrupted, check distribution history.' });
      try {
        const result = await mediaAction<Preview>(projectId, job.destination.tool!, { ...job.destination.arguments, pending_operation_id: job.preview!.pending_operation_id });
        if (result.status !== 'applied') throw new Error('The channel did not confirm this operation. Check distribution history.');
        const ids = result.result?.resourceIds ?? [];
        if (job.destination.stage === 'prepare') {
          if (!ids[0]) throw new Error('The native container was created without a usable ID. Reconcile it before preparing another.');
          const parameters = { ...job.parameters, [job.destination.provider === 'spotify' ? 'asset_id' : 'snapchat_media_id']: ids[0] };
          update(job.key, await prepare({ ...job, parameters, ids, preview: undefined, state: 'details' }));
        } else update(job.key, { state: 'accepted', preview: undefined, ids, message: 'Upload accepted. Channel processing and ad creation are separate.' });
      } catch (reason) { update(job.key, { state: 'failed', preview: undefined, message: reason instanceof Error ? reason.message : 'Upload was not confirmed. Check distribution history before preparing another.' }); }
    }
    lock.current = false; setBusy(false); onChange();
  }
  const review = jobs.filter(job => job.state === 'review').length, details = jobs.filter(job => job.state === 'details').length;
  function fieldValue(job: Job, key: string, value: unknown) { update(job.key, { parameters: { ...job.parameters, [key]: value } }); }
  return <LibraryDialog title={`Distribute ${assets.length === 1 ? 'creative' : `${assets.length} creatives`}`} onClose={busy ? () => {} : onClose} wide>
    <div className={styles.dialogBody}>
      <p className="inline-note">Reuse the files in your Adport library. Each channel receives its own copy after you review the preview. Uploads do not activate ads.</p>
      {loading ? <p role="status">Loading enabled channel accounts…</p> : null}
      {!jobs.length ? <div className={styles.destinationList}>{accounts.map(destination => <label key={keyFor(destination)}><input type="checkbox" checked={selected.has(keyFor(destination))} disabled={busy} onChange={event => setSelected(current => { const next = new Set(current); if (event.target.checked) next.add(keyFor(destination)); else next.delete(keyFor(destination)); return next; })} /><Provider name={destination.provider} /><span><strong>{destination.account_name}</strong><small>{destination.account_id}</small></span></label>)}</div> : jobs.map(job => <section key={job.key} className={styles.distributionJob}>
        <div className={styles.jobHeading}><Provider name={job.destination.provider} /><strong>{job.asset.name}</strong><span className={styles.jobStatus} data-status={job.state}>{job.state === 'review' ? 'Ready to approve' : job.state === 'accepted' ? 'Upload accepted' : job.state === 'details' ? 'Choose details' : job.state === 'unavailable' ? 'Unavailable' : 'Needs review'}</span></div>
        <p className="inline-note">{job.destination.account_name} · {job.destination.note}</p>
        {job.state === 'details' ? <div className={styles.providerFields}>{job.destination.fields?.filter(field => field.key !== 'poster_expected_sha256' || !job.parameters.poster_media_id).map(field => <label key={field.key} className={styles.field}>{field.label}
          {field.key === 'poster_media_id' ? <select value={String(job.parameters[field.key] ?? '')} disabled={busy} onChange={event => { const poster = libraryAssets.find(asset => asset.id === event.target.value); update(job.key, { parameters: { ...job.parameters, poster_media_id: poster?.id, poster_expected_sha256: poster?.sha256 } }); }}><option value="">Choose an image</option>{libraryAssets.filter(asset => asset.content_type.startsWith('image/')).map(asset => <option key={asset.id} value={asset.id}>{asset.name}</option>)}</select>
            : field.schema.enum ? <select value={String(job.parameters[field.key] ?? '')} disabled={busy} onChange={event => fieldValue(job, field.key, event.target.value)}><option value="">Choose an option</option>{field.schema.enum.map(value => <option key={value} value={value}>{value}</option>)}</select>
              : field.schema.type === 'boolean' || typeof field.schema.const === 'boolean' ? <span className={styles.checkboxField}><input type="checkbox" disabled={busy} checked={job.parameters[field.key] === true} onChange={event => fieldValue(job, field.key, event.target.checked)} />Confirm</span>
                : <input value={String(job.parameters[field.key] ?? '')} disabled={busy} onChange={event => fieldValue(job, field.key, event.target.value)} />}
        </label>)}</div> : null}
        {job.state === 'review' && job.preview ? <div className={styles.approval}><strong>{job.preview.preview.summary}</strong><ul>{job.preview.preview.changes.map((change, index) => <li key={index}>{change}</li>)}</ul>{job.preview.preview.coercions?.map((note, index) => <p key={index}>{note}</p>)}{job.preview.preview.notes?.map((note, index) => <p key={index} className="inline-note">{note}</p>)}</div> : null}
        {job.message ? <p role={job.state === 'failed' ? 'alert' : undefined} className={job.state === 'failed' ? styles.error : 'inline-note'}>{job.message}</p> : null}
        {job.ids?.length ? <p className={styles.nativeIds}>Channel reference: {job.ids.join(', ')}</p> : null}
      </section>)}
      {!loading && !accounts.length ? <p>No enabled channel accounts are available for this project. Connect a platform and enable its account first.</p> : null}
      {error ? <p className={styles.error} role="alert">{error}</p> : null}
    </div>
    <div className={styles.dialogFooter}><button className="button secondary" type="button" disabled={busy} onClick={onClose}>Close</button>{!jobs.length ? <button type="button" className="button" onClick={() => void start()} disabled={busy || loading || !selected.size}>{busy ? 'Preparing…' : 'Prepare previews'}</button> : <>{details ? <button type="button" className="button secondary" disabled={busy} onClick={() => void prepareDetails()}>Review details</button> : null}{review ? <button type="button" className="button" disabled={busy} onClick={() => void apply()}>{busy ? 'Uploading…' : `Approve ${review} ${review === 1 ? 'operation' : 'operations'}`}</button> : null}</>}</div>
  </LibraryDialog>;
}
