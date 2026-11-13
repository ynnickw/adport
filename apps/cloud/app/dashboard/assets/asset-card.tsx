'use client';

import { memo } from 'react';
import type { MediaAsset } from '@adport/core';
import { AssetPreview } from './asset-preview';
import { AssetMenu } from './asset-menu';
import { formatBytes, type MediaPlatform } from './media-client';
import styles from './assets.module.css';

export const AssetCard = memo(function AssetCard({ asset, projectId, connectedPlatforms, canEdit, onPreview, onUpdate, onRemove, onTag }: { asset: MediaAsset; projectId: string; connectedPlatforms: readonly MediaPlatform[]; canEdit: boolean; onPreview(asset: MediaAsset): void; onUpdate(asset: MediaAsset): void; onRemove(asset: MediaAsset): void; onTag(tag: string): void }) {
  return <article className={`card ${styles.asset}`}>
    <button type="button" className={styles.previewButton} aria-label={`Preview ${asset.name}`} onClick={() => onPreview(asset)}><AssetPreview asset={asset} projectId={projectId} /></button>
    <div className={styles.details}><div className={styles.cardHeading}><button type="button" className={styles.assetName} onClick={() => onPreview(asset)} title={asset.name}>{asset.name}</button>{canEdit ? <AssetMenu asset={asset} projectId={projectId} connectedPlatforms={connectedPlatforms} onUpdate={onUpdate} onRemove={onRemove} /> : null}</div>
      <p>{formatBytes(asset.byte_length)}{asset.width && asset.height ? ` · ${asset.width} × ${asset.height}` : ''}</p>
      {asset.tags?.length ? <div className={styles.assetLabels}>{asset.tags.slice(0, 2).map(tag => <button type="button" key={tag} onClick={() => onTag(tag)}>{tag}</button>)}{asset.tags.length > 2 ? <span title={asset.tags.slice(2).join(', ')}>+{asset.tags.length - 2}</span> : null}</div> : null}
    </div>
  </article>;
});
