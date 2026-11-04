'use client';

import { useEffect, useId, useMemo, useRef, useState, type DragEvent } from 'react';
import type { MediaAsset } from '@adport/core';
import { MEDIA_PLATFORMS } from '@adport/core/media-platforms';
import { Provider } from '@/components/ui';
import { AssetPreview } from './asset-preview';
import { AssetEditor } from './asset-editor';
import { AssetDistribution } from './asset-distribution';
import { AssetRemoval } from './asset-removal';
import { LibraryDialog } from './library-dialog';
import { applyLibraryChange, formatBytes, mediaAction, responseJson, uploadProjectFile } from './media-client';
import styles from './assets.module.css';

const DRAG_TYPE = 'application/x-adport-media';
type UploadJob = { id: string; name: string; size: number; state: string; percent?: number; mediaId?: string; error?: string };
type Distribution = { id: string; provider: string; account_id: string; status: string; resource_ids: string[]; created_at: string };
type LibraryPage = { assets: MediaAsset[]; truncated: boolean; next_cursor?: string };
function UploadIcon() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M12 16V3m-5 5 5-5 5 5M4 15v5a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-5" /></svg>; }

export function AssetLibrary({ projectId, projectName, initialAssets, truncated: initialTruncated, initialCursor, canUpload, acceptedTypes, maxBytes, storageOrigin }: {
  projectId: string; projectName: string; initialAssets: MediaAsset[]; truncated: boolean; initialCursor?: string; canUpload: boolean; acceptedTypes: string[]; maxBytes: number; storageOrigin: string;
}) {
  const [assets, setAssets] = useState(initialAssets), [truncated, setTruncated] = useState(initialTruncated), [cursor, setCursor] = useState(initialCursor);
  const [query, setQuery] = useState(''), [kind, setKind] = useState(''), [platform, setPlatform] = useState(''), [tag, setTag] = useState(''), [revision, setRevision] = useState(0), [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set()), [uploadJobs, setUploadJobs] = useState<UploadJob[]>([]), [dragging, setDragging] = useState(false), [labelBusy, setLabelBusy] = useState(false);
  const [notice, setNotice] = useState(''), [error, setError] = useState(''), [editing, setEditing] = useState<MediaAsset[] | null>(null), [distributing, setDistributing] = useState<MediaAsset[] | null>(null), [preview, setPreview] = useState<MediaAsset | null>(null), [history, setHistory] = useState<Distribution[]>([]);
  const [removing, setRemoving] = useState<MediaAsset[] | null>(null), previewId = useRef<string | null>(null), listGeneration = useRef(0);
  const picker = useRef<HTMLInputElement>(null), pendingFiles = useRef<Array<{ job: UploadJob; file: File }>>([]), workers = useRef(0), initialLoad = useRef(true), id = useId();
  const endpoint = `/api/media?project_id=${encodeURIComponent(projectId)}`;
  const selectedAssets = useMemo(() => assets.filter(asset => selected.has(asset.id)), [assets, selected]);
  const tags = useMemo(() => [...new Set(assets.flatMap(asset => asset.tags ?? []))].sort(), [assets]);
  const activeUploads = uploadJobs.filter(job => !['Ready', 'Needs review', 'Removed'].includes(job.state)).length;
  const refresh = () => setRevision(value => value + 1);
  function listUrl(nextCursor?: string) { const params = new URLSearchParams({ project_id: projectId, limit: '60' }); if (query) params.set('query', query); if (kind) params.set('kind', kind); if (platform) params.set('platform', platform); if (tag) params.set('tag', tag); if (nextCursor) params.set('cursor', nextCursor); return `/api/media?${params}`; }
  useEffect(() => {
    if (initialLoad.current) { initialLoad.current = false; return; }
    const generation = ++listGeneration.current;
    const controller = new AbortController();
    const timer = setTimeout(() => { setLoading(true); void fetch(listUrl(), { cache: 'no-store', signal: controller.signal }).then(responseJson<LibraryPage>).then(result => { if (generation !== listGeneration.current) return; setAssets(result.assets); setCursor(result.next_cursor); setTruncated(result.truncated); }).catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'The library could not be refreshed.'); }).finally(() => { if (!controller.signal.aborted && generation === listGeneration.current) setLoading(false); }); }, query ? 220 : 0);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [projectId, query, kind, platform, tag, revision]);
  useEffect(() => { setSelected(new Set()); }, [query, kind, platform, tag]);
  function updateJob(jobId: string, values: Partial<UploadJob>) { setUploadJobs(current => current.map(job => job.id === jobId ? { ...job, ...values } : job)); }
  function drain() {
    while (workers.current < 2 && pendingFiles.current.length) {
      const next = pendingFiles.current.shift()!; workers.current++;
      void uploadProjectFile({ projectId, storageOrigin, file: next.file, maxBytes, acceptedTypes, progress: (state, percent, mediaId) => updateJob(next.job.id, { state, percent, ...(mediaId ? { mediaId } : {}) }) })
        .then(mediaId => { updateJob(next.job.id, { state: 'Ready', percent: 100, mediaId }); refresh(); })
        .catch(reason => updateJob(next.job.id, { state: 'Needs review', error: reason instanceof Error ? reason.message : 'This file could not be uploaded.' }))
        .finally(() => { workers.current--; drain(); });
    }
  }
  function enqueue(files: File[]) {
    if (!canUpload || !files.length) return;
    if (files.length + pendingFiles.current.length + workers.current > 50) { setError('Add up to 50 files to the upload queue at a time.'); return; }
    setError(''); setNotice('');
    const batch = files.map(file => ({ file, job: { id: crypto.randomUUID(), name: file.name, size: file.size, state: 'Queued' } as UploadJob }));
    pendingFiles.current.push(...batch); setUploadJobs(current => [...current, ...batch.map(value => value.job)]); drain();
  }
  async function verify(job: UploadJob) {
    if (!job.mediaId) return; updateJob(job.id, { state: 'Verifying', error: undefined });
    try { await responseJson(await fetch(endpoint, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ media_id: job.mediaId }), signal: AbortSignal.timeout(120_000) })); updateJob(job.id, { state: 'Ready', percent: 100 }); refresh(); }
    catch (reason) { updateJob(job.id, { state: 'Needs review', error: reason instanceof Error ? reason.message : 'This upload is not ready.' }); }
  }
  async function showPreview(asset: MediaAsset) {
    previewId.current = asset.id; setPreview(asset); setHistory([]);
    try { const [fresh, records] = await Promise.all([mediaAction<{ asset: MediaAsset }>(projectId, 'media_get', { media_id: asset.id }), mediaAction<{ distributions: Distribution[] }>(projectId, 'media_distributions', { media_id: asset.id })]); if (previewId.current !== asset.id) return; setPreview(current => current?.id === asset.id ? fresh.asset : current); setHistory(records.distributions); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'The latest file preview could not be loaded.'); }
  }
  async function more() {
    if (!cursor || loading) return; setLoading(true); const generation = ++listGeneration.current;
    try { const result = await responseJson<LibraryPage>(await fetch(listUrl(cursor), { cache: 'no-store' })); if (generation !== listGeneration.current) return; setAssets(current => [...current, ...result.assets.filter(asset => !current.some(value => value.id === asset.id))]); setCursor(result.next_cursor); setTruncated(result.truncated); }
    catch (reason) { if (generation === listGeneration.current) setError(reason instanceof Error ? reason.message : 'More files could not be loaded.'); } finally { if (generation === listGeneration.current) setLoading(false); }
  }
  function toggle(assetId: string) { setSelected(current => { const next = new Set(current); if (next.has(assetId)) next.delete(assetId); else if (next.size < 50) next.add(assetId); return next; }); }
  async function labelDrop(event: DragEvent, provider: string) {
    if (!canUpload || labelBusy || !event.dataTransfer.types.includes(DRAG_TYPE)) return;
    event.preventDefault(); event.stopPropagation();
    let payload: { projectId?: unknown; ids?: unknown }; try { payload = JSON.parse(event.dataTransfer.getData(DRAG_TYPE)); } catch { return; }
    if (payload.projectId !== projectId || !Array.isArray(payload.ids) || !payload.ids.length || payload.ids.length > 50 || payload.ids.some(value => typeof value !== 'string' || !assets.some(asset => asset.id === value))) { setError('Drag files from this project’s current library.'); return; }
    setLabelBusy(true); setError(''); let count = 0;
    for (const asset of assets.filter(value => (payload.ids as string[]).includes(value.id))) {
      try { await applyLibraryChange(projectId, 'media_update_metadata', { media_id: asset.id, expected_sha256: asset.sha256, expected_version: asset.metadata_version ?? 1, platforms: [...new Set([...(asset.platforms ?? []), provider])] }); count++; }
      catch { setError('Some labels could not be saved. Refresh before making another change.'); }
    }
    setLabelBusy(false); setNotice(`${count} ${count === 1 ? 'creative labeled' : 'creatives labeled'}. No channel upload was requested.`); refresh();
  }
  function fileDrag(event: DragEvent) { if (canUpload && event.dataTransfer.types.includes('Files')) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; setDragging(true); } }
  return <div className={styles.library} onDragOver={fileDrag} onDragEnter={fileDrag} onDragLeave={event => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setDragging(false); }} onDrop={event => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); setDragging(false); enqueue(Array.from(event.dataTransfer.files)); } }} onPaste={event => { if (event.clipboardData.files.length) { event.preventDefault(); enqueue(Array.from(event.clipboardData.files)); } }}>
    {canUpload ? <section className={styles.dropzone} data-dragging={dragging} aria-label="Upload creative files">
      <div className={styles.uploadIcon}><UploadIcon /></div><div><h2>{dragging ? 'Drop files to upload' : 'Drop your next creative here'}</h2><p>Images, videos, audio and PDFs · up to {Math.floor(maxBytes / 1024 / 1024)} MB each</p></div>
      <input className={styles.hiddenInput} ref={picker} id={id} type="file" multiple accept={acceptedTypes.join(',')} onChange={event => { enqueue(Array.from(event.target.files ?? [])); event.target.value = ''; }} />
      <button className="button" type="button" onClick={() => picker.current?.click()}><UploadIcon />Upload files</button><span className={styles.dropHint}>Choose multiple files, drop them anywhere in the library, or paste an image.</span>
    </section> : <p className="notice">You can browse this library. Editing access is required to upload and organize files.</p>}
    {uploadJobs.some(job => job.state !== 'Removed') ? <section className={styles.queue} aria-label="Upload queue"><div className={styles.queueHeading}><strong>{activeUploads ? `${activeUploads} ${activeUploads === 1 ? 'file' : 'files'} in progress` : 'Recent uploads'}</strong><button type="button" onClick={() => setUploadJobs(current => current.filter(job => !['Ready', 'Removed'].includes(job.state)))}>Clear completed</button></div>{uploadJobs.filter(job => job.state !== 'Removed').map(job => <div key={job.id} className={styles.queueItem}><div><strong>{job.name}</strong><small>{formatBytes(job.size)}{job.error ? ` · ${job.error}` : ''}</small></div><span data-status={job.state}>{job.state}{job.state === 'Uploading' && job.percent !== undefined ? ` ${job.percent}%` : ''}</span>{!['Ready', 'Needs review', 'Queued'].includes(job.state) ? <progress max={100} value={job.percent} aria-label={`Upload progress for ${job.name}`} /> : null}{job.state === 'Queued' ? <button type="button" aria-label={`Remove ${job.name} from queue`} onClick={() => { pendingFiles.current = pendingFiles.current.filter(value => value.job.id !== job.id); updateJob(job.id, { state: 'Removed' }); }}>×</button> : job.state === 'Needs review' && job.mediaId ? <button type="button" onClick={() => void verify(job)}>Verify upload</button> : null}</div>)}</section> : null}
    <div className={styles.libraryToolbar}><div className={styles.search}><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5.5" /><path d="m13 13 4 4" /></svg><input aria-label="Search creatives" placeholder="Search creatives…" value={query} onChange={event => setQuery(event.target.value)} /></div><select aria-label="Filter by platform label" value={platform} onChange={event => setPlatform(event.target.value)}><option value="">All platforms</option>{MEDIA_PLATFORMS.map(value => <option key={value} value={value}>{value === 'x' ? 'X' : value[0]!.toUpperCase() + value.slice(1)}</option>)}</select><select aria-label="Filter by tag" value={tag} onChange={event => setTag(event.target.value)}><option value="">All tags</option>{[...new Set([...tags, ...(tag ? [tag] : [])])].map(value => <option key={value} value={value}>{value}</option>)}</select><button className="button secondary" type="button" onClick={refresh} disabled={loading}>{loading ? 'Refreshing…' : 'Refresh'}</button></div>
    <div className={styles.typeTabs} role="group" aria-label="Filter by file type">{[['', 'All files'], ['image', 'Images'], ['video', 'Videos'], ['audio', 'Audio'], ['document', 'Documents']].map(([value, label]) => <button type="button" key={value} aria-pressed={kind === value} onClick={() => setKind(value!)}>{label}</button>)}<span>{assets.length} {truncated ? 'shown' : assets.length === 1 ? 'file' : 'files'}</span></div>
    <div className={styles.channelLabels}><span>Channel labels <small>Drag a creative onto a channel</small></span><div>{MEDIA_PLATFORMS.map(value => <button type="button" key={value} className={styles.channelLabel} aria-pressed={platform === value} onClick={() => setPlatform(current => current === value ? '' : value)} onDragOver={event => { if (canUpload && event.dataTransfer.types.includes(DRAG_TYPE)) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; } }} onDrop={event => void labelDrop(event, value)} disabled={labelBusy}><Provider name={value} /></button>)}</div></div>
    {error || notice ? <p role={error ? 'alert' : 'status'} className={error ? styles.error : styles.notice}>{error || notice}<button type="button" aria-label="Dismiss notice" onClick={() => { setError(''); setNotice(''); }}>×</button></p> : null}
    {assets.length ? <><div className={styles.selectionBar}><button type="button" onClick={() => setSelected(selected.size ? new Set() : new Set(assets.slice(0, 50).map(asset => asset.id)))}>{selected.size ? 'Clear selection' : 'Select shown'}</button><span>{selected.size ? `${selected.size} selected` : 'Select files to organize or distribute'}</span>{selectedAssets.length && canUpload ? <><button className="button secondary" type="button" onClick={() => setRemoving(selectedAssets)}>Remove</button><button className="button secondary" type="button" onClick={() => setEditing(selectedAssets)}>Organize</button><button className="button" type="button" onClick={() => setDistributing(selectedAssets)}>Distribute</button></> : null}</div>
      <div className={styles.grid} aria-busy={loading}>{assets.map(asset => <article className={`card ${styles.asset}`} data-selected={selected.has(asset.id)} key={asset.id} draggable={canUpload} onDragStart={event => { const ids = selected.has(asset.id) ? [...selected] : [asset.id]; event.dataTransfer.setData(DRAG_TYPE, JSON.stringify({ projectId, ids })); event.dataTransfer.effectAllowed = 'copy'; }}>
        <label className={styles.cardSelection}><input type="checkbox" aria-label={`Select ${asset.name}`} checked={selected.has(asset.id)} onChange={() => toggle(asset.id)} /></label>
        <button type="button" className={styles.previewButton} aria-label={`Preview ${asset.name}`} onClick={() => void showPreview(asset)}><AssetPreview asset={asset} projectId={projectId} /></button>
        <div className={styles.details}><button type="button" className={styles.assetName} onClick={() => void showPreview(asset)} title={asset.name}>{asset.name}</button><p>{formatBytes(asset.byte_length)}{asset.width && asset.height ? ` · ${asset.width} × ${asset.height}` : ''}</p><div className={styles.assetLabels}>{asset.platforms?.map(value => <span key={value} title={`Labeled for ${value}`}><Provider name={value} /></span>)}{asset.tags?.map(value => <button type="button" key={value} onClick={() => setTag(value)}>{value}</button>)}</div></div>
      </article>)}</div></> : <section className={styles.empty}><UploadIcon /><h2>{query || kind || platform || tag ? 'No matching creatives' : 'Your creative library starts here'}</h2><p>{query || kind || platform || tag ? 'Try another search or clear a filter.' : `Upload once to ${projectName}, organize your files and reuse them across channels.`}</p></section>}
    {truncated ? <button className={`button secondary ${styles.loadMore}`} type="button" disabled={loading || !cursor} onClick={() => void more()}>{loading ? 'Loading…' : 'Load more creatives'}</button> : null}
    {editing ? <AssetEditor projectId={projectId} assets={editing} onChange={refresh} onClose={() => setEditing(null)} /> : null}
    {distributing ? <AssetDistribution projectId={projectId} assets={distributing} libraryAssets={assets} onChange={refresh} onClose={() => setDistributing(null)} /> : null}
    {removing ? <AssetRemoval projectId={projectId} assets={removing} onChange={() => { refresh(); setSelected(new Set()); }} onClose={() => setRemoving(null)} /> : null}
    {preview ? <LibraryDialog title={preview.name} onClose={() => { previewId.current = null; setPreview(null); }} wide><div className={styles.inspector}><AssetPreview asset={preview} projectId={projectId} expanded /><aside><p className={styles.inspectorType}>{preview.content_type}</p><p>{formatBytes(preview.byte_length)}{preview.width && preview.height ? ` · ${preview.width} × ${preview.height}` : ''}</p><div className={styles.assetLabels}>{preview.platforms?.map(value => <span key={value}><Provider name={value} /></span>)}{preview.tags?.map(value => <span key={value}>{value}</span>)}</div>{preview.preview_url ? <a href={preview.preview_url} target="_blank" rel="noreferrer" className="button secondary">Open original</a> : null}{canUpload ? <div className={styles.inspectorActions}><button type="button" className="button secondary" onClick={() => { setEditing([preview]); setPreview(null); }}>Organize</button><button type="button" className="button" onClick={() => { setDistributing([preview]); setPreview(null); }}>Distribute</button></div> : null}<h3>Channel uploads</h3>{history.length ? <ol className={styles.history}>{history.map(record => <li key={record.id}><Provider name={record.provider} /><strong>{record.status === 'ACCEPTED' ? 'Upload accepted' : 'Needs reconciliation'}</strong><small>{record.account_id}</small>{record.resource_ids.length ? <code>{record.resource_ids.join(', ')}</code> : null}</li>)}</ol> : <p className="inline-note">No tracked channel uploads yet. Platform labels indicate where you plan to use this file.</p>}<details className={styles.references}><summary>File reference</summary><p>Media ID<code>{preview.id}</code></p><p>SHA-256<code>{preview.sha256}</code></p></details></aside></div></LibraryDialog> : null}
  </div>;
}
