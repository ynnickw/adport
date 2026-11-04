'use client';

import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import type { MediaAsset } from '@adport/core';
import { applyLibraryChange, mediaAction } from './media-client';
import styles from './assets.module.css';

export function AssetMenu({ asset, projectId, onUpdate, onRemove }: { asset: MediaAsset; projectId: string; onUpdate(asset: MediaAsset): void; onRemove(asset: MediaAsset): void }) {
  const [open, setOpen] = useState(false), [tags, setTags] = useState(''), [busy, setBusy] = useState(false), [attempted, setAttempted] = useState(false), [error, setError] = useState('');
  const [position, setPosition] = useState<CSSProperties>({}), trigger = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null), input = useRef<HTMLInputElement>(null), lock = useRef(false), id = useId();
  function close() { setOpen(false); trigger.current?.focus(); }
  useEffect(() => {
    if (!open) return;
    input.current?.focus();
    const outside = (event: PointerEvent) => { if (!panel.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); setOpen(false); trigger.current?.focus(); } };
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, [open]);
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      if (!trigger.current || !panel.current) return;
      const rect = trigger.current.getBoundingClientRect(), width = Math.min(280, window.innerWidth - 24), height = panel.current.offsetHeight;
      setPosition({ width, left: Math.max(12, Math.min(rect.right - width, window.innerWidth - width - 12)), top: Math.max(12, Math.min(rect.bottom + 6, window.innerHeight - height - 12)) });
    };
    place(); window.addEventListener('resize', place); window.addEventListener('scroll', place, true);
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [open, error]);
  async function save() {
    if (lock.current || attempted) return;
    const values = [...new Set(tags.split(',').map(value => value.trim().toLowerCase()).filter(Boolean))];
    if (values.length > 24 || values.some(value => value.length > 40 || /[\x00-\x1f\x7f]/.test(value))) { setError('Use up to 24 tags, each up to 40 characters.'); return; }
    lock.current = true; setBusy(true); setError('');
    try {
      const result = await applyLibraryChange(projectId, 'media_update_metadata', { media_id: asset.id, expected_sha256: asset.sha256, expected_version: asset.metadata_version ?? 1, tags: values });
      const next = result.result?.details?.asset;
      if (result.status !== 'applied' || next?.id !== asset.id || next.sha256 !== asset.sha256 || next.status !== 'READY') throw new Error('The tag change was not confirmed.');
      onUpdate(next); setAttempted(false); close();
    } catch { setAttempted(true); setError('Tags were not confirmed. Reload this file before saving again.'); }
    finally { lock.current = false; setBusy(false); }
  }
  async function reload() {
    if (lock.current) return; lock.current = true; setBusy(true);
    try { const { asset: next } = await mediaAction<{ asset: MediaAsset }>(projectId, 'media_get', { media_id: asset.id }); if (next.id !== asset.id || next.sha256 !== asset.sha256) throw new Error('File changed'); onUpdate(next); setTags(next.tags?.join(', ') ?? ''); setAttempted(false); setError(''); }
    catch { setError('This file could not be refreshed.'); } finally { lock.current = false; setBusy(false); }
  }
  return <>
    <button ref={trigger} className={styles.moreButton} type="button" aria-label={`Actions for ${asset.name}`} aria-haspopup="dialog" aria-expanded={open} aria-controls={id} onClick={() => { if (!open && !lock.current) setTags(asset.tags?.join(', ') ?? ''); setOpen(value => !value); }}>
      <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><circle cx="4" cy="10" r="1.5" /><circle cx="10" cy="10" r="1.5" /><circle cx="16" cy="10" r="1.5" /></svg>
    </button>
    {open ? createPortal(<div ref={panel} id={id} role="dialog" aria-label={`Tags for ${asset.name}`} className={styles.assetMenu} style={position} onBlur={event => { if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget) && event.relatedTarget !== trigger.current) setOpen(false); }}>
      <form onSubmit={event => { event.preventDefault(); void save(); }}><label htmlFor={`${id}-tags`}>Tags</label><input ref={input} id={`${id}-tags`} value={tags} placeholder="launch, testimonial" onChange={event => setTags(event.target.value)} disabled={busy || attempted} aria-describedby={`${id}-hint`} /><small id={`${id}-hint`}>Separate with commas.</small>
        {error ? <p role="alert">{error}</p> : null}<div>{attempted ? <button type="button" className="button secondary" disabled={busy} onClick={() => void reload()}>{busy ? 'Loading…' : 'Reload file'}</button> : <button className="button" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save tags'}</button>}</div></form>
      <div className={styles.menuLinks}>{asset.preview_url ? <a href={asset.preview_url} target="_blank" rel="noreferrer">Open original ↗</a> : null}<button type="button" disabled={busy} onClick={() => { close(); onRemove(asset); }}>Remove file</button></div>
    </div>, document.body) : null}
  </>;
}
