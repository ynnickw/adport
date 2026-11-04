'use client';

import { useEffect, useRef, useState } from 'react';
import type { MediaAsset } from '@adport/core';
import styles from './assets.module.css';

export function AssetPreview({ asset, projectId, expanded = false }: { asset: MediaAsset; projectId: string; expanded?: boolean }) {
  const ref = useRef<HTMLDivElement>(null), [visible, setVisible] = useState(expanded), [failed, setFailed] = useState(false);
  useEffect(() => { setFailed(false); }, [asset.preview_url]);
  useEffect(() => {
    if (expanded || !ref.current) return;
    if (typeof IntersectionObserver === 'undefined') { setVisible(true); return; }
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) { setVisible(true); observer.disconnect(); } }, { rootMargin: '100px' });
    observer.observe(ref.current); return () => observer.disconnect();
  }, [expanded]);
  const image = asset.content_type.startsWith('image/'), video = asset.content_type.startsWith('video/'), audio = asset.content_type.startsWith('audio/');
  const source = asset.preview_url;
  return <div ref={ref} className={expanded ? styles.expandedPreview : styles.preview}>
    {!failed && visible && source && image ? <img src={expanded ? source : `/api/media/preview?project_id=${encodeURIComponent(projectId)}&media_id=${asset.id}`} alt={asset.name} loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} />
      : !failed && visible && source && video ? <><video key={expanded ? 'player' : 'thumbnail'} src={expanded ? source : `${source}#t=0.1`} controls={expanded} muted={!expanded} preload="metadata" playsInline aria-label={asset.name} onError={() => setFailed(true)} onLoadedData={event => { if (!expanded && event.currentTarget.currentTime === 0 && event.currentTarget.duration > 0.1) event.currentTarget.currentTime = 0.1; }} />{!expanded ? <span className={styles.play} aria-hidden="true">▶</span> : null}</>
        : visible && source && audio && expanded ? <audio src={source} controls preload="metadata" aria-label={asset.name} />
          : <div className={styles.filePlaceholder}><span aria-hidden="true">{video ? '▷' : audio ? '♫' : image ? '▧' : 'PDF'}</span><small>{failed ? 'Open original to preview' : video ? 'Video' : audio ? 'Audio' : image ? 'Image' : 'Document'}</small></div>}
    {!expanded ? <span className={styles.kindBadge}>{video ? 'Video' : audio ? 'Audio' : image ? 'Image' : 'PDF'}</span> : null}
  </div>;
}
