'use client';

import { useEffect, useRef, useState } from 'react';
import type { MediaAsset } from '@adport/core';
import { mediaAction } from './media-client';
import styles from './assets.module.css';

type PreviewProps = { asset: MediaAsset; projectId: string; expanded?: boolean; onRefresh?(asset: MediaAsset): void };

export function AssetPreview(props: PreviewProps) {
  return <PreviewSource key={`${props.projectId}:${props.asset.id}:${props.asset.sha256}`} {...props} />;
}

function PreviewSource({ asset, projectId, expanded = false, onRefresh }: PreviewProps) {
  const ref = useRef<HTMLDivElement>(null), currentSource = useRef(asset.preview_url), rejectedSources = useRef(new Set<string>());
  const mounted = useRef(true), refreshing = useRef(false), automaticRefresh = useRef(false);
  const [visible, setVisible] = useState(expanded), [failed, setFailed] = useState(false), [source, setSource] = useState(asset.preview_url), [busy, setBusy] = useState(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  function adopt(url: string) { currentSource.current = url; setSource(url); setFailed(false); }
  useEffect(() => {
    // Renewed signed URLs must not restart an already loaded video or image.
    if ((!source || failed) && asset.preview_url && asset.preview_url !== source && !rejectedSources.current.has(asset.preview_url)) adopt(asset.preview_url);
  }, [asset.preview_url, source, failed]);
  useEffect(() => {
    if (expanded || !ref.current) return;
    if (typeof IntersectionObserver === 'undefined') { setVisible(true); return; }
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) { setVisible(true); observer.disconnect(); } }, { rootMargin: '100px' });
    observer.observe(ref.current); return () => observer.disconnect();
  }, [expanded]);
  const documentLabel = asset.content_type === 'text/csv' ? 'CSV' : asset.content_type === 'application/pdf' ? 'PDF' : 'File';
  const image = asset.content_type.startsWith('image/'), video = asset.content_type.startsWith('video/'), audio = asset.content_type.startsWith('audio/');
  async function retry() {
    if (refreshing.current) return;
    refreshing.current = true; setBusy(true);
    const requestedSource = currentSource.current;
    const isCurrent = () => mounted.current && currentSource.current === requestedSource;
    try {
      const { asset: next } = await mediaAction<{ asset: MediaAsset }>(projectId, 'media_get', { media_id: asset.id });
      if (next.id !== asset.id || next.sha256 !== asset.sha256 || next.status !== 'READY' || !next.preview_url) throw new Error('File unavailable');
      if (isCurrent()) { adopt(next.preview_url); onRefresh?.(next); }
    } catch { if (isCurrent()) setFailed(true); } finally { refreshing.current = false; if (mounted.current) setBusy(false); }
  }
  function unavailable() {
    if (currentSource.current) rejectedSources.current.add(currentSource.current);
    if (asset.preview_url && asset.preview_url !== currentSource.current && !rejectedSources.current.has(asset.preview_url)) { adopt(asset.preview_url); return; }
    setFailed(true);
    if (!automaticRefresh.current) { automaticRefresh.current = true; void retry(); }
  }
  return <div ref={ref} className={expanded ? styles.expandedPreview : styles.preview}>
    {!failed && visible && (source || !expanded) && image ? <img src={expanded ? source : `/api/media/preview?project_id=${encodeURIComponent(projectId)}&media_id=${asset.id}`} alt={asset.name} loading="lazy" referrerPolicy="no-referrer" onError={unavailable} />
      : !failed && visible && source && video ? <><video key={expanded ? 'player' : 'thumbnail'} src={expanded ? source : `${source}#t=0.1`} controls={expanded} muted={!expanded} preload="metadata" playsInline aria-label={asset.name} onError={unavailable} onLoadedData={event => { if (!expanded && event.currentTarget.currentTime === 0 && event.currentTarget.duration > 0.1) event.currentTarget.currentTime = 0.1; }} />{!expanded ? <span className={styles.play} aria-hidden="true">▶</span> : null}</>
        : !failed && visible && source && audio && expanded ? <audio src={source} controls preload="metadata" aria-label={asset.name} onError={unavailable} />
          : <div className={styles.filePlaceholder}><span aria-hidden="true">{video ? '▷' : audio ? '♫' : image ? '▧' : documentLabel}</span><small>{busy ? 'Refreshing preview…' : failed ? 'Preview unavailable' : video ? 'Video' : audio ? 'Audio' : image ? 'Image' : 'Document'}</small>{(failed || !source) && expanded && (image || video || audio) ? <button type="button" className="button secondary" disabled={busy} onClick={() => void retry()}>{busy ? 'Loading…' : 'Retry preview'}</button> : null}</div>}
    {!expanded ? <span className={styles.kindBadge}>{video ? 'Video' : audio ? 'Audio' : image ? 'Image' : documentLabel}</span> : null}
  </div>;
}
