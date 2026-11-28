'use client';

import { useEffect, useId, useRef, useState } from 'react';
import type { InviteProfile, InviteProfileScope } from '@/lib/member-profiles';
import { Button, Chevron, Input } from './controls';
import { ProfileIdentity } from './profile-identity';

export function InviteProfileField({ scope, targetId }: { scope: InviteProfileScope; targetId: string }) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const results = useRef<HTMLUListElement>(null);
  const [value, setValue] = useState('');
  const [selected, setSelected] = useState<InviteProfile>();
  const [lookup, setLookup] = useState<{ term: string; profiles: InviteProfile[]; failed?: boolean }>();
  const term = value.trim();
  const searching = !selected && term.length >= 2;
  const current = lookup?.term === term ? lookup : undefined;
  const matches = current?.profiles ?? [];

  useEffect(() => {
    const field = input.current;
    const form = field?.form;
    const reset = () => {
      field?.setCustomValidity('');
      setValue('');
      setSelected(undefined);
      setLookup(undefined);
    };
    form?.addEventListener('reset', reset);
    return () => form?.removeEventListener('reset', reset);
  }, []);

  useEffect(() => {
    if (!searching) return;
    const request = new AbortController();
    const timeout = window.setTimeout(async () => {
      try {
        const response = await fetch('/api/members/search', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ scope, targetId, query: term }),
          signal: request.signal,
        });
        if (!response.ok) throw new Error('Profile search is unavailable.');
        const data = await response.json() as { profiles: InviteProfile[] };
        if (!request.signal.aborted) setLookup({ term, profiles: data.profiles });
      } catch {
        if (!request.signal.aborted) setLookup({ term, profiles: [], failed: true });
      }
    }, 250);
    return () => {
      window.clearTimeout(timeout);
      request.abort();
    };
  }, [scope, targetId, term, searching]);

  function choose(profile: InviteProfile) {
    input.current?.setCustomValidity('');
    setValue(profile.email);
    setSelected(profile);
    setLookup(undefined);
    input.current?.focus();
  }

  const status = selected ? 'Existing Adport profile selected'
    : !searching ? 'Use their full email address if they’re outside this organization.'
    : !current ? 'Searching profiles…'
    : current.failed ? 'Profile search is unavailable. You can still enter their email address.'
    : matches.length ? `${matches.length} matching ${matches.length === 1 ? 'profile' : 'profiles'}`
    : 'No matching profiles. Enter an email address to send an invitation.';

  return <div className="field invite-profile-field">
    <label htmlFor={id}>Name or email</label>
    <Input ref={input} id={id} name="email" type="email" inputMode="text" autoComplete="off"
      autoCapitalize="none" spellCheck={false} required maxLength={320} data-autofocus="fine-pointer"
      placeholder="Search profiles or enter an email" aria-describedby={`${id}-status`} value={value}
      onChange={event => {
        event.currentTarget.setCustomValidity('');
        const next = event.currentTarget.value;
        setValue(next);
        setSelected(undefined);
        setLookup(previous => previous?.term === next.trim() ? previous : undefined);
      }}
      onInvalid={event => {
        if (event.currentTarget.validity.typeMismatch) event.currentTarget.setCustomValidity('Select a profile or enter a full email address.');
      }}
      onKeyDown={event => {
        if (event.key !== 'ArrowDown') return;
        const firstMatch = results.current?.querySelector('button');
        if (firstMatch) {
          event.preventDefault();
          firstMatch.focus();
        }
      }} />
    <p className="invite-profile-status" id={`${id}-status`} role="status">{status}</p>
    {selected ? <div className="invite-profile-selected">
      <ProfileIdentity name={selected.displayName} email={selected.email} avatarUrl={selected.avatarUrl} />
    </div> : null}
    {searching && matches.length > 0 ? <ul className="invite-profile-results" ref={results} aria-label="Matching profiles">
      {matches.map(profile => {
        const identity = <ProfileIdentity name={profile.displayName} email={profile.email} avatarUrl={profile.avatarUrl} />;
        return <li key={profile.email}>{profile.alreadyHasAccess
          ? <div className="invite-profile-option">{identity}<span className="person-email">Already has access</span></div>
          : <Button className="invite-profile-option" type="button" onClick={() => choose(profile)}>{identity}<Chevron direction="right" /></Button>}
        </li>;
      })}
    </ul> : null}
  </div>;
}
