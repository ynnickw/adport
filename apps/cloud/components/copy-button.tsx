'use client';

import { useState } from 'react';
import { Button } from './controls';
import { useToast } from './toast';

export function CopyButton({ value, label, caption = label, className = '', onCopyFailure }: {
  value: string; label: string; caption?: string; className?: string; onCopyFailure?: () => void;
}) {
  const [failed, setFailed] = useState(false);
  const toast = useToast();
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setFailed(false);
      toast('Copied to clipboard.');
    } catch {
      setFailed(true);
      onCopyFailure?.();
    }
  }
  return <Button type="button" className={`button secondary small ${className}`} onClick={() => void copy()} aria-label={label}>
    <span aria-live="polite">{failed ? 'Select text to copy' : caption}</span>
  </Button>;
}
