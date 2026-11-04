'use client';

import { useId, useRef, useState, type FormEvent } from 'react';
import type { MediaAsset } from '@adport/core';
import { Button, Input } from '@/components/controls';
import styles from './assets.module.css';

async function jsonResponse<T>(response: Response): Promise<T> {
  const data = await response.json();
  if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : 'The upload could not be completed.');
  return data as T;
}

export function AssetLibrary({ projectId, projectName, initialAssets, truncated: initialTruncated, canUpload, acceptedTypes, maxBytes, storageOrigin }: {
  projectId: string; projectName: string; initialAssets: MediaAsset[]; truncated: boolean; canUpload: boolean; acceptedTypes: string[]; maxBytes: number; storageOrigin: string;
}) {
  const [assets, setAssets] = useState(initialAssets), [truncated, setTruncated] = useState(initialTruncated);
  const [progress, setProgress] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const fileInput = useRef<HTMLInputElement>(null), inputId = useId();
  const endpoint = `/api/media?project_id=${encodeURIComponent(projectId)}`;
  const maxMegabytes = Math.floor(maxBytes / 1024 / 1024);
  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (progress) return;
    const file = fileInput.current?.files?.[0]; if (!file) { setError('Choose a file first.'); return; }
    const contentType = file.type === 'audio/x-wav' ? 'audio/wav' : file.type;
    if (!file.size || file.size > maxBytes || !acceptedTypes.includes(contentType)) { setError(`Choose a supported image, video or audio file up to ${maxMegabytes} MB.`); return; }
    setError(''); setNotice(''); setProgress('Checking file…');
    try {
      const bytes = await file.arrayBuffer();
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      const sha256 = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
      const prepared = await jsonResponse<{ media_id: string; upload_url: string }>(await fetch(endpoint, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: file.name, byte_length: file.size, content_type: contentType, sha256 }), signal: AbortSignal.timeout(60_000),
      }));
      const destination = new URL(prepared.upload_url);
      if (destination.origin !== storageOrigin || !destination.pathname.startsWith('/storage/v1/object/upload/sign/creative-media/')) throw new Error('The upload destination could not be verified.');
      setProgress('Uploading…');
      const uploaded = await fetch(destination, { method: 'PUT', headers: { 'content-type': contentType, 'x-upsert': 'false', 'cache-control': 'max-age=0' }, body: bytes, signal: AbortSignal.timeout(300_000) });
      if (!uploaded.ok) throw new Error('The file could not be uploaded. Start a new upload to try again.');
      setProgress('Verifying…');
      await jsonResponse(await fetch(endpoint, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ media_id: prepared.media_id }), signal: AbortSignal.timeout(60_000) }));
      const library = await jsonResponse<{ assets: MediaAsset[]; truncated: boolean }>(await fetch(endpoint, { cache: 'no-store', signal: AbortSignal.timeout(60_000) }));
      setAssets(library.assets); setTruncated(library.truncated); setNotice(`${file.name} is ready in ${projectName}. Your assistant can now select it for an ad.`);
      if (fileInput.current) fileInput.current.value = '';
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'The upload could not be completed.'); }
    finally { setProgress(''); }
  }
  return <div className="stack">
    {canUpload ? <form onSubmit={upload} className={`card ${styles.upload}`} aria-busy={Boolean(progress)}>
      <label htmlFor={inputId}>Choose an image, video, audio or PDF file <span className="muted">· up to {maxMegabytes} MB</span></label>
      <div className={styles.controls}><Input ref={fileInput} id={inputId} type="file" accept={acceptedTypes.join(',')} required disabled={Boolean(progress)} /><Button className="button" type="submit" disabled={Boolean(progress)}>{progress || `Upload to ${projectName}`}</Button></div>
      <p className="inline-note">Files stay private to this project. Publishing an ad requires a separate preview and approval.</p>
    </form> : <p className="notice">Your role or plan allows viewing this library. Editing access is required to upload files.</p>}
    <p role={error ? 'alert' : 'status'} aria-live="polite" className={error ? 'error' : 'inline-note'}>{error || progress || notice}</p>
    {assets.length ? <div className={styles.grid}>{assets.map(asset => <article className={`card ${styles.asset}`} key={asset.id}>
      <div className={styles.preview}>{asset.preview_url ? asset.content_type.startsWith('image/') ? <img src={asset.preview_url} alt={asset.name} loading="lazy" referrerPolicy="no-referrer" />
        : asset.content_type.startsWith('video/') ? <video src={asset.preview_url} controls preload="none" playsInline aria-label={asset.name} />
          : asset.content_type.startsWith('audio/') ? <audio src={asset.preview_url} controls preload="none" aria-label={asset.name} /> : <a href={asset.preview_url} target="_blank" rel="noreferrer">Download {asset.name}</a> : <span>Preview unavailable</span>}</div>
      <div className={styles.details}><h2>{asset.name}</h2><p className="inline-note">{asset.content_type} · {asset.byte_length < 1024 * 1024 ? `${Math.ceil(asset.byte_length / 1024)} KB` : `${(asset.byte_length / 1024 / 1024).toFixed(1)} MB`}{asset.width && asset.height ? ` · ${asset.width} × ${asset.height}` : ''}</p>
        <details><summary>File reference</summary><p>Media ID <code>{asset.id}</code></p><p>SHA-256 <code>{asset.sha256}</code></p></details></div>
    </article>)}</div> : <section className="card"><div className="card-body"><h2>Your creative library is ready</h2><p className="subhead">Add your first image, video, audio or PDF file to use it with your assistant.</p></div></section>}
    {truncated ? <p className="inline-note">Showing the first 100 files. Your assistant can page through the full library.</p> : null}
  </div>;
}
