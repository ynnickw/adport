'use client';

import { useId, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { LOGO_ACCEPT, MAX_LOGO_BYTES, type WorkspaceLogoKind } from '@/lib/workspace-logos';
import { Button } from './controls';
import { WorkspaceLogo } from './workspace-logo';

export function WorkspaceLogoEditor({ kind, id, name, logoUrl }: {
  kind: WorkspaceLogoKind;
  id: string;
  name: string;
  logoUrl: string | null;
}) {
  const router = useRouter();
  const labelId = useId();
  const hintId = useId();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<'upload' | 'remove' | null>(null);
  const [message, setMessage] = useState<{ error?: string; success?: string }>({});
  const [saved, setSaved] = useState<{ source: string | null; url: string | null } | null>(null);
  const currentUrl = saved?.source === logoUrl ? saved.url : logoUrl;

  async function change(file: File | null) {
    if (busy) return;
    setMessage({});
    if (file && (!file.size || file.size > MAX_LOGO_BYTES || !LOGO_ACCEPT.split(',').includes(file.type))) {
      setMessage({ error: 'Choose a PNG, JPG, or WebP image up to 2 MB.' });
      return;
    }
    setBusy(file ? 'upload' : 'remove');
    try {
      const form = new FormData();
      if (file) form.set('file', file);
      const response = await fetch(`/api/workspace-logos/${kind}/${id}`, { method: file ? 'POST' : 'DELETE', body: file ? form : undefined });
      const result = await response.json() as { logoUrl?: string | null; error?: string };
      if (!response.ok) throw new Error(result.error ?? 'The logo could not be saved. Please try again.');
      setSaved({ source: logoUrl, url: result.logoUrl ?? null });
      setMessage({ success: file ? 'Logo uploaded.' : 'Logo removed.' });
      router.refresh();
    } catch (error) {
      setMessage({ error: error instanceof Error ? error.message : 'The logo could not be saved. Please try again.' });
    } finally { setBusy(null); }
  }

  return <div className="workspace-logo-editor stack" role="group" aria-labelledby={labelId} aria-busy={Boolean(busy)}>
    <h3 id={labelId}>{kind === 'project' ? 'Project logo' : 'Organization logo'}</h3>
    <div className="workspace-logo-editor-row">
      <WorkspaceLogo name={name} logoUrl={currentUrl} className="project-monogram workspace-logo-preview" />
      <div className="stack">
        <div className="row-actions">
          <input ref={input} className="sr-only" type="file" accept={LOGO_ACCEPT} aria-label={`Choose ${kind} logo`} aria-describedby={hintId} disabled={Boolean(busy)} onChange={event => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = '';
            if (file) void change(file);
          }} />
          <Button type="button" className="button secondary small" disabled={Boolean(busy)} aria-describedby={hintId} onClick={() => input.current?.click()}>{busy === 'upload' ? 'Uploading…' : currentUrl ? 'Replace logo' : 'Upload logo'}</Button>
          {currentUrl ? <Button type="button" className="button secondary small" disabled={Boolean(busy)} onClick={() => void change(null)}>{busy === 'remove' ? 'Removing…' : 'Remove logo'}</Button> : null}
        </div>
        <p id={hintId} className="inline-note">PNG, JPG, or WebP up to 2 MB. A square image works best.</p>
      </div>
    </div>
    {message.error ? <p className="field-error" role="alert">{message.error}</p> : null}
    {message.success ? <p className="inline-note" role="status">{message.success}</p> : null}
  </div>;
}
