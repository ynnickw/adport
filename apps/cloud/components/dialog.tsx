'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { Button } from './controls';

export function Dialog({ title, children, onClose, className = '' }: { title: string; children: React.ReactNode; onClose: () => void; className?: string }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const dialog = ref.current;
    dialog?.showModal();
    return () => { dialog?.close(); previous?.focus(); };
  }, []);
  return <dialog ref={ref} className={`app-dialog ${className}`} aria-labelledby={titleId}
    onCancel={event => { event.preventDefault(); onClose(); }}
    onMouseDown={event => {
      if (event.target !== event.currentTarget) return;
      const rect = event.currentTarget.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose();
    }}>
    <div className="dialog-heading"><h2 id={titleId}>{title}</h2><Button type="button" className="icon-button" aria-label={`Close ${title}`} onClick={onClose}>×</Button></div>
    {children}
  </dialog>;
}

export function DialogTrigger({ label, title, children, className = 'button secondary' }: { label: string; title: string; children: React.ReactNode; className?: string }) {
  const [open, setOpen] = useState(false);
  return <><Button type="button" className={className} onClick={() => setOpen(true)}>{label}</Button>{open ? <Dialog title={title} onClose={() => setOpen(false)}>{children}</Dialog> : null}</>;
}
