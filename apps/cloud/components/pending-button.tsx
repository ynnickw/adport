'use client';

import type { ComponentProps } from 'react';
import { useFormStatus } from 'react-dom';
import { Button } from './controls';

export function PendingButton({ pendingLabel = 'Please wait…', children, ...props }: ComponentProps<typeof Button> & { pendingLabel?: string }) {
  const { pending } = useFormStatus();
  return <Button {...props} type="submit" pending={pending} pendingLabel={pendingLabel}>{children}</Button>;
}
