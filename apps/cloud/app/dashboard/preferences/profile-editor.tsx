'use client';

import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Input } from '@/components/controls';
import { ProfileAvatar } from '@/components/profile-identity';
import { useToast } from '@/components/toast';
import { IMAGE_UPLOAD_ACCEPT } from '@/lib/image-upload';
import { MAX_PROFILE_PHOTO_BYTES } from '@/lib/member-profiles';

interface Profile { displayName: string; avatarUrl: string | null }
type PhotoDraft = { action: 'keep' | 'remove' } | { action: 'replace'; file: File; preview?: string };

export function ProfileEditor({ profile }: { profile: Profile }) {
  const router = useRouter();
  const toast = useToast();
  const nameId = useId();
  const photoHintId = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  const [saved, setSaved] = useState(profile);
  const [displayName, setDisplayName] = useState(profile.displayName);
  const [photo, setPhoto] = useState<PhotoDraft>({ action: 'keep' });
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const previewUrl = photo.action === 'replace' ? photo.preview ?? saved.avatarUrl
    : photo.action === 'remove' ? null : saved.avatarUrl;
  const file = photo.action === 'replace' ? photo.file : undefined;
  const dirty = displayName.trim() !== saved.displayName || photo.action !== 'keep';
  const readingPhoto = photo.action === 'replace' && !photo.preview;

  useEffect(() => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const preview = typeof reader.result === 'string' ? reader.result : undefined;
      setPhoto(current => current.action === 'replace' && current.file === file
        ? (preview ? { ...current, preview } : { action: 'keep' }) : current);
    };
    reader.onerror = () => {
      setError('This photo could not be previewed. Choose the file again.');
      setPhoto({ action: 'keep' });
    };
    reader.readAsDataURL(file);
    return () => {
      reader.onload = null;
      reader.onerror = null;
      reader.abort();
    };
  }, [file]);

  function choosePhoto(file: File) {
    if (!file.size || file.size > MAX_PROFILE_PHOTO_BYTES || !IMAGE_UPLOAD_ACCEPT.split(',').includes(file.type)) {
      setError('Choose a JPG, PNG, or WebP up to 4 MB.');
      return;
    }
    setError(undefined);
    setPhoto({ action: 'replace', file });
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!dirty || saving || readingPhoto) return;
    setSaving(true);
    setError(undefined);
    const form = new FormData();
    form.set('displayName', displayName.trim());
    form.set('photoAction', photo.action);
    if (file) form.set('file', file);
    try {
      const response = await fetch('/api/profile', { method: 'POST', body: form });
      const result = await response.json().catch(() => null) as (Profile & { error?: string }) | null;
      if (!response.ok || !result?.displayName) throw new Error(result?.error ?? 'Your profile could not be saved. Try again.');
      setSaved(result);
      setDisplayName(result.displayName);
      setPhoto({ action: 'keep' });
      toast('Profile saved.');
      router.refresh();
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Your profile could not be saved. Try again.');
    } finally {
      setSaving(false);
    }
  }

  return <form className="account-profile-form" onSubmit={save} aria-label="Edit profile" aria-busy={saving}>
    <div className="card-body account-profile-fields">
      <div className="account-photo-field">
        <ProfileAvatar name={displayName || saved.displayName} avatarUrl={previewUrl} className="account-photo-preview" />
        <div>
          <div className="field-label">Profile photo</div>
          <div className="row-actions">
            <input ref={fileInput} className="sr-only" type="file" tabIndex={-1} accept={IMAGE_UPLOAD_ACCEPT}
              aria-label="Choose a profile photo" disabled={saving} onChange={event => {
                const selected = event.currentTarget.files?.[0];
                event.currentTarget.value = '';
                if (selected) choosePhoto(selected);
              }} />
            <Button type="button" className="button secondary small" disabled={saving} aria-describedby={photoHintId}
              onClick={() => fileInput.current?.click()}>{previewUrl || file ? 'Change photo' : 'Upload photo'}</Button>
            {previewUrl || file ? <Button type="button" className="link-button" disabled={saving} onClick={() => {
              setError(undefined);
              setPhoto({ action: saved.avatarUrl ? 'remove' : 'keep' });
            }}>Remove photo</Button> : null}
          </div>
          <p id={photoHintId} className="field-hint">JPG, PNG, or WebP up to 4 MB.</p>
          {photo.action === 'remove' ? <p className="field-hint" role="status">Your photo will be removed when you save.</p> : null}
        </div>
      </div>
      <div className="field">
        <label className="field-label" htmlFor={nameId}>Display name</label>
        <Input id={nameId} autoComplete="name" maxLength={120} required disabled={saving}
          value={displayName} onChange={event => setDisplayName(event.target.value)} />
        <p className="field-hint">Your name and photo appear in team lists and member search.</p>
      </div>
      {error ? <p className="field-error" role="alert">{error}</p> : null}
    </div>
    <div className="account-profile-actions">
      {dirty ? <Button type="button" className="button secondary" disabled={saving} onClick={() => {
        setDisplayName(saved.displayName);
        setPhoto({ action: 'keep' });
        setError(undefined);
      }}>Cancel</Button> : null}
      <Button type="submit" className="button" disabled={!dirty || !displayName.trim() || readingPhoto}
        pending={saving} pendingLabel="Saving…">Save profile</Button>
    </div>
  </form>;
}
