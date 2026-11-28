'use client';

import { useId, useState } from 'react';
import { type ToolSelection, type ToolProvider } from '@adport/core/tool-catalog';
import { CLOUD_PROVIDERS } from '@/lib/cloud/types';
import { Button, Checkbox } from './controls';
import { InfoTooltip } from './info-tooltip';
import { providerLabel } from '@/lib/cloud/providers';
import { standardToolSelection, TOOL_PROFILE_OPTIONS } from '@/lib/mcp-tool-selection';

export function ToolCatalogFields({ initialSelection, suggestedProviders, disabled = false, manage = false, onSelectionChange }: {
  initialSelection: ToolSelection; disabled?: boolean; manage?: boolean; onSelectionChange?: (selection: ToolSelection) => void;
  suggestedProviders?: readonly ToolProvider[];
}) {
  const platformControlsId = useId();
  const [profile, setProfile] = useState(initialSelection.profile);
  const [allPlatforms, setAllPlatforms] = useState(initialSelection.providers === null);
  const [customProviders, setCustomProviders] = useState<readonly ToolProvider[]>();
  const [editingPlatforms, setEditingPlatforms] = useState(false);
  const chosen = customProviders ?? initialSelection.providers ?? [];
  const providers = allPlatforms ? null : chosen;
  function updateProfile(next: ToolSelection['profile']) {
    setProfile(next);
    onSelectionChange?.({ profile: next, providers });
  }
  function updatePlatforms(next: ToolSelection['providers'], nextProfile = profile) {
    setAllPlatforms(next === null);
    if (next !== null) setCustomProviders(next);
    onSelectionChange?.({ profile: nextProfile, providers: next });
  }
  function toggle(provider: ToolProvider, checked: boolean) {
    const next = checked ? [...chosen, provider] : chosen.filter(value => value !== provider);
    updatePlatforms(next);
  }
  function useStandard() {
    const selection = standardToolSelection({ profile, providers }, suggestedProviders);
    setProfile(selection.profile);
    updatePlatforms(selection.providers, selection.profile);
  }
  const platformSummary = providers === null ? 'All platforms' : providers.length ? `${providers.length} selected` : 'None selected';
  return <div className={`assistant-access-fields${manage ? '' : ' tool-catalog-fields'}`}>
    <fieldset className="assistant-access-field" disabled={disabled}>
      <legend>Tool access</legend>
      <div className="assistant-profile-options">
        {TOOL_PROFILE_OPTIONS.map(option => <div className="assistant-profile-option" key={option.value}>
          <label className="assistant-radio-card">
            <input type="radio" name="tool_profile" value={option.value} checked={profile === option.value} onChange={() => updateProfile(option.value)} />
            <strong>{option.label}</strong>
          </label>
          <InfoTooltip label={`About ${option.label} access`}>{option.details}</InfoTooltip>
        </div>)}
      </div>
      {manage && profile === 'full' ? <Button className="link-button assistant-use-standard" type="button" onClick={useStandard}>Use Standard</Button> : null}
    </fieldset>
    <div className="tool-platform-field">
      <div className="tool-platform-header">
        <span className="field-label">Platforms <InfoTooltip label="About platform access">The assistant receives tools for the selected platforms. Accounts must be enabled in each project. All platforms also includes tools added in the future.</InfoTooltip></span>
        {!manage ? <div className="tool-platform-summary"><span>{platformSummary}</span><Button type="button" className="link-button" disabled={disabled}
          aria-expanded={editingPlatforms} aria-controls={platformControlsId} onClick={() => setEditingPlatforms(value => !value)}>{editingPlatforms ? 'Done' : 'Edit platforms'}</Button></div> : null}
      </div>
      <input type="hidden" name="tool_platform_mode" value={allPlatforms ? 'all' : 'selected'} />
      {providers?.map(provider => <input key={provider} type="hidden" name="tool_providers" value={provider} />)}
      <div id={platformControlsId} hidden={!manage && !editingPlatforms}>
        {manage || editingPlatforms ? <fieldset className="assistant-access-field" disabled={disabled}>
          <legend className="sr-only">Platform selection</legend>
          <div className="assistant-platform-mode">
            <label className="assistant-radio-card"><input type="radio" name={`${platformControlsId}-mode`} checked={allPlatforms} onChange={() => updatePlatforms(null)} /><span>All platforms</span></label>
            <label className="assistant-radio-card"><input type="radio" name={`${platformControlsId}-mode`} checked={!allPlatforms} onChange={() => updatePlatforms(chosen)} /><span>Choose platforms</span></label>
          </div>
          {!allPlatforms ? <div className="tool-platform-options assistant-platform-options">{CLOUD_PROVIDERS.map(provider => <label className="tool-platform-option" key={provider}>
            <Checkbox checked={chosen.includes(provider)} onChange={event => toggle(provider, event.target.checked)} /><span>{providerLabel(provider)}</span>
          </label>)}</div> : null}
          {providers?.length === 0 ? <p className="field-hint">No platform tools will be available.</p> : null}
        </fieldset> : null}
      </div>
    </div>
  </div>;
}
