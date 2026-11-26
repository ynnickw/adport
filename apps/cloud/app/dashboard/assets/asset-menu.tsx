'use client';

import { useId, useRef, useState } from 'react';
import type { MediaAsset } from '@adport/core';
import { ActionPopover } from '@/components/action-popover';
import { Button, Input } from '@/components/controls';
import { ProviderLogo, providerLabel } from '@/components/logos';
import { applyLibraryChange, mediaAction, type MediaPlatform } from './media-client';
import styles from './assets.module.css';

export function AssetMenu({ asset, projectId, connectedPlatforms, onUpdate, onRemove }: { asset: MediaAsset; projectId: string; connectedPlatforms: readonly MediaPlatform[]; onUpdate(asset: MediaAsset): void; onRemove(asset: MediaAsset): void }) {
  const [tags, setTags] = useState(''), [busy, setBusy] = useState(false), [attempted, setAttempted] = useState(false), [error, setError] = useState('');
  const [platforms, setPlatforms] = useState<MediaPlatform[]>([]);
  const lock = useRef(false), id = useId();
  async function save(close: () => void) {
    if (lock.current || attempted) return;
    const values = [...new Set(tags.split(',').map(value => value.trim().toLowerCase()).filter(Boolean))];
    if (values.length > 24 || values.some(value => value.length > 40 || /[\x00-\x1f\x7f]/.test(value))) { setError('Use up to 24 tags, each up to 40 characters.'); return; }
    lock.current = true; setBusy(true); setError('');
    try {
      const currentPlatforms = asset.platforms ?? [], platformsChanged = platforms.length !== currentPlatforms.length || platforms.some(platform => !currentPlatforms.includes(platform));
      const result = await applyLibraryChange(projectId, 'media_update_metadata', { media_id: asset.id, expected_sha256: asset.sha256, expected_version: asset.metadata_version ?? 1, tags: values, ...(platformsChanged ? { platforms } : {}) });
      const next = result.result?.details?.asset;
      if (result.status !== 'applied' || next?.id !== asset.id || next.sha256 !== asset.sha256 || next.status !== 'READY') throw new Error('The tag change was not confirmed.');
      onUpdate(next); setAttempted(false); close();
    } catch { setAttempted(true); setError('Tags were not confirmed. Reload this file before saving again.'); }
    finally { lock.current = false; setBusy(false); }
  }
  async function reload() {
    if (lock.current) return; lock.current = true; setBusy(true);
    try { const { asset: next } = await mediaAction<{ asset: MediaAsset }>(projectId, 'media_get', { media_id: asset.id }); if (next.id !== asset.id || next.sha256 !== asset.sha256) throw new Error('File changed'); onUpdate(next); setTags(next.tags?.join(', ') ?? ''); setPlatforms([...(next.platforms ?? [])]); setAttempted(false); setError(''); }
    catch { setError('This file could not be refreshed.'); } finally { lock.current = false; setBusy(false); }
  }
  return <ActionPopover label={`Actions for ${asset.name}`} panelLabel={`Tags for ${asset.name}`} width={280} iconOnly
    triggerClassName={styles.moreButton} panelClassName={styles.assetMenu} onOpen={() => {
      if (!lock.current) { setTags(asset.tags?.join(', ') ?? ''); setPlatforms([...(asset.platforms ?? [])]); }
    }} triggerLabel={<svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><circle cx="4" cy="10" r="1.5" /><circle cx="10" cy="10" r="1.5" /><circle cx="16" cy="10" r="1.5" /></svg>}>
    {close => <>
      <form onSubmit={event => { event.preventDefault(); void save(close); }}>
        {connectedPlatforms.length ? <fieldset className={styles.platformTags} disabled={busy || attempted}><legend>Platforms</legend><div>{connectedPlatforms.map(platform => <button type="button" key={platform} aria-pressed={platforms.includes(platform)} onClick={() => setPlatforms(current => current.includes(platform) ? current.filter(value => value !== platform) : [...current, platform])}><span className="provider-logo"><ProviderLogo name={platform} /></span>{providerLabel(platform)}</button>)}</div></fieldset> : null}
        <label htmlFor={`${id}-tags`}>Tags</label><Input data-autofocus id={`${id}-tags`} value={tags} placeholder="launch, testimonial" onChange={event => setTags(event.target.value)} disabled={busy || attempted} aria-describedby={`${id}-hint`} /><small id={`${id}-hint`}>Separate with commas.</small>
        {error ? <p role="alert">{error}</p> : null}<div>{attempted ? <Button type="button" className="button secondary" pending={busy} pendingLabel="Loading…" onClick={() => void reload()}>Reload file</Button> : <Button className="button" type="submit" pending={busy} pendingLabel="Saving…">Save tags</Button>}</div></form>
      <div className={styles.menuLinks}>{asset.preview_url ? <a href={asset.preview_url} target="_blank" rel="noreferrer">Open original ↗</a> : null}<button type="button" disabled={busy} onClick={() => { close(); onRemove(asset); }}>Remove file</button></div>
    </>}
  </ActionPopover>;
}
