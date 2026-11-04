'use client';

import { useState } from 'react';
import type { MediaAsset } from '@adport/core';
import { MEDIA_PLATFORMS } from '@adport/core/media-platforms';
import { Provider } from '@/components/ui';
import { LibraryDialog } from './library-dialog';
import { applyLibraryChange } from './media-client';
import styles from './assets.module.css';

export function AssetEditor({ projectId, assets, onChange, onClose }: { projectId: string; assets: MediaAsset[]; onChange(): void; onClose(): void }) {
  const single = assets.length === 1, [name, setName] = useState(single ? assets[0]!.name : ''), [tags, setTags] = useState(single ? assets[0]!.tags?.join(', ') ?? '' : '');
  const [platforms, setPlatforms] = useState<string[]>(single ? assets[0]!.platforms ?? [] : []), [mode, setMode] = useState('add'), [busy, setBusy] = useState(false), [error, setError] = useState(''), [attempted, setAttempted] = useState(false);
  async function save() {
    if (busy || attempted) return;
    const values = [...new Set(tags.split(',').map(value => value.trim().toLowerCase()).filter(Boolean))];
    if (values.length > 24 || values.some(value => value.length > 40)) { setError('Use up to 24 tags, each no longer than 40 characters.'); return; }
    setBusy(true); setError(''); const failures: string[] = [];
    for (const asset of assets) {
      try { await applyLibraryChange(projectId, 'media_update_metadata', { media_id: asset.id, expected_sha256: asset.sha256, expected_version: asset.metadata_version ?? 1, ...(single ? { name } : {}), tags: single || mode === 'replace' ? values : [...new Set([...(asset.tags ?? []), ...values])], platforms: single || mode === 'replace' ? platforms : [...new Set([...(asset.platforms ?? []), ...platforms])] }); }
      catch { failures.push(asset.name); }
    }
    setBusy(false); setAttempted(true); onChange();
    if (failures.length) setError(`${assets.length - failures.length} saved. Could not save: ${failures.join(', ')}. Close and refresh the library before making another change.`);
    else onClose();
  }
  return <LibraryDialog title={single ? 'Organize creative' : `Organize ${assets.length} creatives`} onClose={busy ? () => {} : onClose}>
    <form onSubmit={event => { event.preventDefault(); void save(); }}>
      <div className={styles.dialogBody}>
        {single ? <label className={styles.field}>Name<input value={name} onChange={event => setName(event.target.value)} maxLength={240} required disabled={busy || attempted} /></label> : <label className={styles.field}>Apply labels<select value={mode} onChange={event => setMode(event.target.value)} disabled={busy || attempted}><option value="add">Add to existing labels</option><option value="replace">Replace existing labels</option></select></label>}
        <label className={styles.field}>Tags<input value={tags} onChange={event => setTags(event.target.value)} placeholder="launch, summer, testimonial" disabled={busy || attempted} /><span>Separate tags with commas.</span></label>
        <fieldset className={styles.platformFieldset} disabled={busy || attempted}><legend>Platform labels</legend><p>Organize where you plan to use these files. Uploading to a channel is a separate action.</p><div className={styles.platformOptions}>{MEDIA_PLATFORMS.map(provider => <label key={provider}><input type="checkbox" checked={platforms.includes(provider)} onChange={event => setPlatforms(current => event.target.checked ? [...current, provider] : current.filter(value => value !== provider))} /><Provider name={provider} /></label>)}</div></fieldset>
        {error ? <p role="alert" className={styles.error}>{error}</p> : null}
      </div>
      <div className={styles.dialogFooter}><button type="button" className="button secondary" disabled={busy} onClick={onClose}>{attempted ? 'Close' : 'Cancel'}</button>{!attempted ? <button className="button" disabled={busy} type="submit">{busy ? 'Saving…' : 'Save changes'}</button> : null}</div>
    </form>
  </LibraryDialog>;
}
