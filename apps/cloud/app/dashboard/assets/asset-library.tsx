'use client';

import { useCallback, useId, useMemo, useRef, useState, type DragEvent } from 'react';
import type { MediaAsset } from '@adport/core';
import { Provider } from '@/components/ui';
import { AssetCard } from './asset-card';
import { AssetPreview } from './asset-preview';
import { AssetRemoval } from './asset-removal';
import { LibraryDialog } from './library-dialog';
import { formatBytes, mediaAction, responseJson, uploadProjectFile, type MediaPlatform } from './media-client';
import { useLibraryFiles } from './use-library-files';
import styles from './assets.module.css';

type UploadJob = { id: string; name: string; size: number; state: string; percent?: number; mediaId?: string; error?: string };
function UploadIcon() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M12 16V3m-5 5 5-5 5 5M4 15v5a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-5" /></svg>; }

export function AssetLibrary({ projectId, projectName, connectedPlatforms, initialAssets, truncated, initialCursor, canUpload, acceptedTypes, maxBytes, storageOrigin }: {
  projectId: string; projectName: string; connectedPlatforms: readonly MediaPlatform[]; initialAssets: MediaAsset[]; truncated: boolean; initialCursor?: string; canUpload: boolean; acceptedTypes: string[]; maxBytes: number; storageOrigin: string;
}) {
  const [query, setQuery] = useState(''), [kind, setKind] = useState(''), [tag, setTag] = useState('');
  const files = useLibraryFiles(projectId, { assets: initialAssets, truncated, next_cursor: initialCursor }, { query: query.trim(), kind, tag });
  const [uploadJobs, setUploadJobs] = useState<UploadJob[]>([]), [dragging, setDragging] = useState(false), [error, setError] = useState('');
  const [preview, setPreview] = useState<MediaAsset | null>(null), [removing, setRemoving] = useState<MediaAsset[] | null>(null);
  const picker = useRef<HTMLInputElement>(null), pendingFiles = useRef<Array<{ job: UploadJob; file: File }>>([]), workers = useRef(0), verifying = useRef(new Set<string>()), id = useId();
  const tags = useMemo(() => [...new Set([...files.assets.flatMap(asset => asset.tags ?? []), ...(tag ? [tag] : [])])].sort(), [files.assets, tag]);
  const activeUploads = uploadJobs.filter(job => !['Ready', 'Needs review', 'Removed'].includes(job.state)).length;
  const updateAsset = useCallback((asset: MediaAsset) => {
    files.update(asset);
    setPreview(current => current?.id === asset.id ? { ...current, ...asset, preview_url: asset.preview_url ?? current.preview_url } : current);
  }, [files.update]);
  const uploadedAsset = useCallback((asset: MediaAsset) => {
    files.update(asset, true);
    if (!asset.preview_url) void mediaAction<{ asset: MediaAsset }>(projectId, 'media_get', { media_id: asset.id }).then(({ asset: fresh }) => {
      if (fresh.id === asset.id && fresh.sha256 === asset.sha256 && fresh.status === 'READY') updateAsset(fresh);
    }).catch(() => { /* The source is ready; its full preview can be retried independently. */ });
  }, [files.update, projectId, updateAsset]);
  const removeAsset = useCallback((asset: MediaAsset) => setRemoving([asset]), []);
  function updateJob(jobId: string, values: Partial<UploadJob>) { setUploadJobs(current => current.map(job => job.id === jobId ? { ...job, ...values } : job)); }
  function drain() {
    while (workers.current < 2 && pendingFiles.current.length) {
      const next = pendingFiles.current.shift()!; workers.current++;
      void uploadProjectFile({ projectId, storageOrigin, file: next.file, maxBytes, acceptedTypes, ready: uploadedAsset, progress: (state, percent, mediaId) => updateJob(next.job.id, { state, percent, ...(mediaId ? { mediaId } : {}) }) })
        .then(mediaId => updateJob(next.job.id, { state: 'Ready', percent: 100, mediaId }))
        .catch(reason => updateJob(next.job.id, { state: 'Needs review', error: reason instanceof Error ? reason.message : 'This file could not be uploaded.' }))
        .finally(() => { workers.current--; drain(); });
    }
  }
  function enqueue(input: File[]) {
    if (!canUpload || !input.length) return;
    if (input.length + pendingFiles.current.length + workers.current > 50) { setError('Add up to 50 files to the upload queue at a time.'); return; }
    setError('');
    const batch = input.map(file => ({ file, job: { id: crypto.randomUUID(), name: file.name, size: file.size, state: 'Queued' } as UploadJob }));
    pendingFiles.current.push(...batch); setUploadJobs(current => [...current, ...batch.map(value => value.job)]); drain();
  }
  async function verify(job: UploadJob) {
    if (!job.mediaId || verifying.current.has(job.id)) return; verifying.current.add(job.id); updateJob(job.id, { state: 'Verifying', error: undefined });
    try {
      const result = await responseJson<{ asset: MediaAsset }>(await fetch(`/api/media?project_id=${encodeURIComponent(projectId)}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ media_id: job.mediaId }), signal: AbortSignal.timeout(120_000) }));
      if (result.asset?.id !== job.mediaId || result.asset.status !== 'READY') throw new Error('The file is not ready.');
      uploadedAsset(result.asset); updateJob(job.id, { state: 'Ready', percent: 100 });
    } catch (reason) { updateJob(job.id, { state: 'Needs review', error: reason instanceof Error ? reason.message : 'This upload is not ready.' }); }
    finally { verifying.current.delete(job.id); }
  }
  function fileDrag(event: DragEvent) { if (canUpload && event.dataTransfer.types.includes('Files')) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; setDragging(true); } }
  const filtered = !!(query || kind || tag);
  return <section className={styles.library} aria-label="Creative files" onDragOver={fileDrag} onDragEnter={fileDrag} onDragLeave={event => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setDragging(false); }} onDrop={event => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); setDragging(false); enqueue(Array.from(event.dataTransfer.files)); } }} onPaste={event => { if (event.clipboardData.files.length) { event.preventDefault(); enqueue(Array.from(event.clipboardData.files)); } }}>
    {dragging ? <div className={styles.dropOverlay} role="status"><UploadIcon />Drop files to upload</div> : null}
    <div className={styles.libraryToolbar}>
      <div className={styles.search}><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5.5" /><path d="m13 13 4 4" /></svg><input type="search" aria-label="Search creatives" placeholder="Search files…" value={query} onChange={event => setQuery(event.target.value)} /></div>
      <select aria-label="File type" value={kind} onChange={event => setKind(event.target.value)}>{[['', 'All files'], ['image', 'Images'], ['video', 'Videos'], ['audio', 'Audio'], ['document', 'Documents']].map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
      {tags.length ? <select aria-label="Filter by tag" value={tag} onChange={event => setTag(event.target.value)}><option value="">All tags</option>{tags.map(value => <option key={value} value={value}>{value}</option>)}</select> : null}
      {filtered ? <button type="button" className={styles.clearFilters} onClick={() => { setQuery(''); setKind(''); setTag(''); }}>Clear</button> : null}
      <span className={styles.fileCount}>{files.assets.length} {files.truncated ? 'shown' : files.assets.length === 1 ? 'file' : 'files'}</span>
      <button type="button" className={styles.refreshButton} aria-label="Refresh library" title="Refresh library" disabled={files.loading || files.loadingMore} onClick={() => void files.refresh()}><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M16.5 8A6.7 6.7 0 1 0 17 12M16.5 3.5V8H12" /></svg></button>
      {canUpload ? <><input className={styles.hiddenInput} ref={picker} id={id} type="file" multiple accept={acceptedTypes.join(',')} onChange={event => { enqueue(Array.from(event.target.files ?? [])); event.target.value = ''; }} /><button className="button" type="button" title={`Choose or drop files · up to ${Math.floor(maxBytes / 1024 / 1024)} MB each`} onClick={() => picker.current?.click()}><UploadIcon />Upload files</button></> : null}
    </div>
    {uploadJobs.some(job => job.state !== 'Removed') ? <section className={styles.queue} aria-label="Upload queue"><div className={styles.queueHeading}><strong>{activeUploads ? `${activeUploads} ${activeUploads === 1 ? 'file' : 'files'} in progress` : 'Recent uploads'}</strong><button type="button" onClick={() => setUploadJobs(current => current.filter(job => !['Ready', 'Removed'].includes(job.state)))}>Clear completed</button></div><div className={styles.queueItems}>{uploadJobs.filter(job => job.state !== 'Removed').map(job => <div key={job.id} className={styles.queueItem}><div><strong>{job.name}</strong><small>{formatBytes(job.size)}{job.error ? ` · ${job.error}` : ''}</small></div><span data-status={job.state}>{job.state}{job.state === 'Uploading' && job.percent !== undefined ? ` ${job.percent}%` : ''}</span>{!['Ready', 'Needs review', 'Queued'].includes(job.state) ? <progress max={100} value={job.percent} aria-label={`Upload progress for ${job.name}`} /> : null}{job.state === 'Queued' ? <button type="button" aria-label={`Remove ${job.name} from queue`} onClick={() => { pendingFiles.current = pendingFiles.current.filter(value => value.job.id !== job.id); updateJob(job.id, { state: 'Removed' }); }}>×</button> : job.state === 'Needs review' && job.mediaId ? <button type="button" onClick={() => void verify(job)}>Verify upload</button> : null}</div>)}</div></section> : null}
    {error || files.error ? <p role="alert" className={styles.error}>{error || files.error}</p> : null}
    {files.assets.length ? <div className={styles.grid} aria-busy={files.loading}>{files.assets.map(asset => <AssetCard key={asset.id} asset={asset} projectId={projectId} connectedPlatforms={connectedPlatforms} canEdit={canUpload} onPreview={setPreview} onUpdate={updateAsset} onRemove={removeAsset} onTag={setTag} />)}</div>
      : <section className={styles.empty}><UploadIcon /><h2>{files.loading ? 'Loading files…' : filtered ? 'No matching files' : 'No files yet'}</h2><p>{filtered ? 'Try another search or clear a filter.' : `Drop files here or upload them to ${projectName}. Your assistant handles the rest.`}</p></section>}
    {files.truncated ? <button className={`button secondary ${styles.loadMore}`} type="button" disabled={files.loading || files.loadingMore || !files.next_cursor} onClick={() => void files.more()}>{files.loadingMore ? 'Loading…' : 'Load more'}</button> : null}
    {removing ? <AssetRemoval projectId={projectId} assets={removing} onRemoved={files.remove} onClose={() => setRemoving(null)} /> : null}
    {preview ? <LibraryDialog title={preview.name} onClose={() => setPreview(null)} wide><div className={styles.inspector}><AssetPreview asset={preview} projectId={projectId} expanded onRefresh={updateAsset} /><aside><p>{preview.content_type}</p><p>{formatBytes(preview.byte_length)}{preview.width && preview.height ? ` · ${preview.width} × ${preview.height}` : ''}</p>{preview.tags?.length ? <div className={styles.assetLabels}>{preview.tags.map(value => <span key={value}>{value}</span>)}</div> : null}{preview.preview_url ? <a href={preview.preview_url} target="_blank" rel="noreferrer" className="button secondary">Open original ↗</a> : null}<details className={styles.references}><summary>Details</summary>{preview.platforms?.length ? <p>{preview.platforms.map(value => <Provider key={value} name={value} />)}</p> : null}<p>Media ID<code>{preview.id}</code></p><p>SHA-256<code>{preview.sha256}</code></p></details></aside></div></LibraryDialog> : null}
  </section>;
}
