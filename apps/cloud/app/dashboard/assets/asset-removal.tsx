'use client';

import { useRef, useState } from 'react';
import type { MediaAsset } from '@adport/core';
import { LibraryDialog } from './library-dialog';
import { mediaAction, type Preview } from './media-client';
import styles from './assets.module.css';

export function AssetRemoval({ projectId, assets, onChange, onClose }: { projectId: string; assets: MediaAsset[]; onChange(): void; onClose(): void }) {
  const [previews, setPreviews] = useState<Array<{ asset: MediaAsset; args: Record<string, unknown>; preview: Preview }>>([]), [busy, setBusy] = useState(false), [finished, setFinished] = useState(false), [error, setError] = useState('');
  const lock = useRef(false);
  async function prepare() {
    if (lock.current) return; lock.current = true; setBusy(true); setError('');
    try {
      const next = [];
      for (const asset of assets) { const args = { media_id: asset.id, expected_sha256: asset.sha256, expected_name: asset.name }; const preview = await mediaAction<Preview>(projectId, 'media_delete', args); if (preview.status !== 'pending_validation' || !preview.pending_operation_id) throw new Error('Removal was not prepared.'); next.push({ asset, args, preview }); }
      setPreviews(next);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not prepare removal.'); }
    finally { lock.current = false; setBusy(false); }
  }
  async function remove() {
    if (lock.current || finished || !previews.length) return; lock.current = true; setBusy(true); const approved = previews; setPreviews([]);
    const failures = [];
    for (const item of approved) { try { await mediaAction(projectId, 'media_delete', { ...item.args, pending_operation_id: item.preview.pending_operation_id }); } catch { failures.push(item.asset.name); } }
    setFinished(true); setBusy(false); lock.current = false; onChange();
    if (failures.length) setError(`Check removal status for: ${failures.join(', ')}. Reload the library before another removal attempt.`); else onClose();
  }
  return <LibraryDialog title={`Remove ${assets.length === 1 ? 'creative' : `${assets.length} creatives`}`} onClose={busy ? () => {} : onClose}>
    <div className={styles.dialogBody}><p>Permanently delete these source files from the Adport library. Copies already uploaded to channels and their ads remain available.</p><ul>{assets.map(asset => <li key={asset.id}>{asset.name}</li>)}</ul>{previews.length ? <p className={styles.error}>This removes the stored files and cannot be undone.</p> : null}{error ? <p className={styles.error} role="alert">{error}</p> : null}</div>
    <div className={styles.dialogFooter}><button type="button" className="button secondary" disabled={busy} onClick={onClose}>{finished ? 'Close' : 'Cancel'}</button>{!finished ? previews.length ? <button type="button" className="button" disabled={busy} onClick={() => void remove()}>{busy ? 'Removing…' : `Delete ${assets.length} ${assets.length === 1 ? 'file' : 'files'}`}</button> : <button type="button" className="button secondary" disabled={busy} onClick={() => void prepare()}>{busy ? 'Checking…' : 'Review removal'}</button> : null}</div>
  </LibraryDialog>;
}
