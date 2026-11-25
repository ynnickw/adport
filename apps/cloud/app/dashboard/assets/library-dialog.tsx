'use client';

import type { ReactNode } from 'react';
import { Dialog } from '@/components/dialog';
import styles from './assets.module.css';

export function LibraryDialog({ title, children, onClose, wide = false }: { title: string; children: ReactNode; onClose(): void; wide?: boolean }) {
  return <Dialog title={title} closeLabel="Close dialog" className={`${styles.dialog} ${wide ? styles.wideDialog : ''}`} onClose={onClose}>{children}</Dialog>;
}
