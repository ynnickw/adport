'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from './controls';
import { Dialog } from './dialog';

interface Confirmation { title: string; description: string; confirmLabel: string }

export function useConfirm() {
  const [options, setOptions] = useState<Confirmation>();
  const completion = useRef<((confirmed: boolean) => void) | undefined>(undefined);
  const confirm = useCallback((next: Confirmation) => new Promise<boolean>(resolve => {
    completion.current?.(false);
    completion.current = resolve;
    setOptions(next);
  }), []);
  useEffect(() => () => completion.current?.(false), []);
  const close = (confirmed: boolean) => {
    completion.current?.(confirmed);
    completion.current = undefined;
    setOptions(undefined);
  };
  const dialog = options ? <Dialog title={options.title} onClose={() => close(false)}>
    <p className="dialog-description">{options.description}</p>
    <div className="modal-actions"><Button type="button" className="button secondary" onClick={() => close(false)}>Cancel</Button><Button type="button" className="button danger" onClick={() => close(true)}>{options.confirmLabel}</Button></div>
  </Dialog> : null;
  return [confirm, dialog] as const;
}
