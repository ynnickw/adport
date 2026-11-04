'use client';

import { useEffect, useRef, useState } from 'react';
import type { MediaAsset } from '@adport/core';
import { mediaAction } from './media-client';
import styles from './assets.module.css';

export function AssetPreview({ asset, projectId, expanded = false, onRefresh }: { asset: MediaAsset; projectId: string; expanded?: boolean; onRefresh?(asset: MediaAsset): void }) {
  const ref = useRef<HTMLDivElement>(null), identity = `${asset.id}:${asset.sha256}`, sourceIdentity = useRef(identity);
  const [visible, setVisible] = useState(expanded), [failed, setFailed] = useState(false), [source, setSource] = useState(asset.preview_url), [busy, setBusy] = useState(false);
  useEffect(() => {
    // Renewed signed URLs must not restart an already loaded video or image.
    if (sourceIdentity.current !== identity || ((!source || failed) && asset.preview_url !== source)) { sourceIdentity.current = identity; setSource(asset.preview_url); setFailed(false); }
  }, [identity, asset.preview_url, source, failed]);
  useEffect(() => {
    if (expanded || !ref.current) return;
    if (typeof IntersectionObserver === 'undefined') { setVisible(true); return; }
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) { setVisible(true); observer.disconnect(); } }, { rootMargin: '100px' });
    observer.observe(ref.current); return () => observer.disconnect();
  }, [expanded]);
  const image = asset.content_type.startsWith('image/'), video = asset.content_type.startsWith('video/'), audio = asset.content_type.startsWith('audio/');
  async function retry() {
    if (busy) return; setBusy(true);
    try {
      const { asset: next } = await mediaAction<{ asset: MediaAsset }>(projectId, 'media_get', { media_id: asset.id });
      if (next.id !== asset.id || next.sha256 !== asset.sha256 || next.status !== 'READY' || !next.preview_url) throw new Error('File unavailable');
      setSource(next.preview_url); setFailed(false); onRefresh?.(next);
    } catch { setFailed(true); } finally { setBusy(false); }
  }
  return <div ref={ref} className={expanded ? styles.expandedPreview : styles.preview}>
    {!failed && visible && (source || !expanded) && image ? <img src={expanded ? source : `/api/media/preview?project_id=${encodeURIComponent(projectId)}&media_id=${asset.id}`} alt={asset.name} loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} />
      : !failed && visible && source && video ? <><video key={expanded ? 'player' : 'thumbnail'} src={expanded ? source : `${source}#t=0.1`} controls={expanded} muted={!expanded} preload="metadata" playsInline aria-label={asset.name} onError={() => setFailed(true)} onLoadedData={event => { if (!expanded && event.currentTarget.currentTime === 0 && event.currentTarget.duration > 0.1) event.currentTarget.currentTime = 0.1; }} />{!expanded ? <span className={styles.play} aria-hidden="true">▶</span> : null}</>
        : !failed && visible && source && audio && expanded ? <audio src={source} controls preload="metadata" aria-label={asset.name} onError={() => setFailed(true)} />
          : <div className={styles.filePlaceholder}><span aria-hidden="true">{video ? '▷' : audio ? '♫' : image ? '▧' : 'PDF'}</span><small>{failed ? 'Preview unavailable' : video ? 'Video' : audio ? 'Audio' : image ? 'Image' : 'Document'}</small>{(failed || !source) && expanded && (image || video || audio) ? <button type="button" className="button secondary" disabled={busy} onClick={() => void retry()}>{busy ? 'Loading…' : 'Retry preview'}</button> : null}</div>}
    {!expanded ? <span className={styles.kindBadge}>{video ? 'Video' : audio ? 'Audio' : image ? 'Image' : 'PDF'}</span> : null}
  </div>;
}
