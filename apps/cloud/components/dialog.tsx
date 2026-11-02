'use client';

import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { Button } from './controls';

const subscribe = () => () => {};

export function Dialog({ title, children, onClose, className = '', portal = false, headerStart, hideTitle = false }: { title: string; children: React.ReactNode; onClose: () => void; className?: string; portal?: boolean; headerStart?: React.ReactNode; hideTitle?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const hydrated = useSyncExternalStore(subscribe, () => true, () => false);
  const ready = !portal || hydrated;
  useEffect(() => {
    if (!ready) return;
    const previous = document.activeElement as HTMLElement | null;
    const dialog = ref.current;
    dialog?.showModal();
    dialog?.querySelector<HTMLElement>('[data-autofocus]')?.focus();
    return () => { dialog?.close(); previous?.focus(); };
  }, [ready]);
  if (!ready) return null;
  const content = <dialog ref={ref} className={`app-dialog ${className}`} aria-labelledby={titleId}
    onCancel={event => { event.preventDefault(); onClose(); }}
    onMouseDown={event => {
      if (event.target !== event.currentTarget) return;
      const rect = event.currentTarget.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose();
    }}>
    <div className="dialog-heading">{headerStart}<h2 id={titleId} className={hideTitle ? 'sr-only' : undefined}>{title}</h2><Button type="button" className="icon-button" aria-label={`Close ${title}`} onClick={onClose}>×</Button></div>
    {children}
  </dialog>;
  return portal ? createPortal(content, document.body) : content;
}

export function DialogTrigger({ label, title, children, className = 'button secondary' }: { label: string; title: string; children: React.ReactNode; className?: string }) {
  const [open, setOpen] = useState(false);
  return <><Button type="button" className={className} onClick={() => setOpen(true)}>{label}</Button>{open ? <Dialog title={title} onClose={() => setOpen(false)}>{children}</Dialog> : null}</>;
}
