'use client';

import { useState } from 'react';
import { type ToolSelection, type ToolProvider } from '@adport/core/tool-catalog';
import { CLOUD_PROVIDERS } from '@/lib/cloud/types';
import { Checkbox, Disclosure } from './controls';
import { Select } from './select';
import { InfoTooltip } from './info-tooltip';
import { providerLabel } from '@/lib/cloud/providers';
import { TOOL_PROFILE_DESCRIPTIONS, TOOL_PROFILE_OPTIONS } from '@/lib/mcp-tool-selection';

const PROFILE_CHOICES = [
  { value: 'reporting', label: 'Reporting', hint: 'Read and report only',
    details: 'View performance and inspect accounts, campaigns, audiences, and conversion settings. This tier cannot make changes.' },
  { value: 'standard', label: 'Standard', hint: 'Reporting and campaign tools',
    details: 'Includes Reporting plus everyday campaign tools. Propose changes to ads, budgets, keywords, or targeting where supported.' },
  { value: 'full', label: 'Full', hint: 'Includes advanced tools',
    details: 'Includes Standard plus advanced tools where supported, such as Google Ads experiments, conversion imports, and Meta custom audiences. Existing permissions and approval rules still apply.' },
] as const;

export function ToolCatalogFields({ initialSelection, disabled = false, manage = false, onSelectionChange }: {
  initialSelection: ToolSelection; disabled?: boolean; manage?: boolean; onSelectionChange?: (selection: ToolSelection) => void;
}) {
  const [profile, setProfile] = useState(initialSelection.profile);
  const [providers, setProviders] = useState<readonly ToolProvider[] | null>(initialSelection.providers);
  const [chosen, setChosen] = useState<readonly ToolProvider[]>(initialSelection.providers ?? []);
  function updateProfile(next: ToolSelection['profile']) {
    setProfile(next);
    onSelectionChange?.({ profile: next, providers });
  }
  function updatePlatforms(next: ToolSelection['providers']) {
    setProviders(next);
    onSelectionChange?.({ profile, providers: next });
  }
  function toggle(provider: ToolProvider, checked: boolean) {
    const next = checked ? [...chosen, provider] : chosen.filter(value => value !== provider);
    setChosen(next); updatePlatforms(next);
  }
  const platformOptions = CLOUD_PROVIDERS.map(provider => <label className="tool-platform-option" key={provider}>
    <Checkbox name="tool_providers" value={provider} checked={providers === null || chosen.includes(provider)}
      onChange={event => toggle(provider, event.target.checked)} /><span>{providerLabel(provider)}</span>
  </label>);
  if (manage) return <div className="assistant-access-fields">
    <fieldset className="assistant-access-field" disabled={disabled}>
      <legend>Tool profile</legend>
      <div className="assistant-profile-options">
        {PROFILE_CHOICES.map(option => <div className="assistant-profile-option" key={option.value}>
          <label className="assistant-radio-card">
            <input type="radio" name="tool_profile" value={option.value} checked={profile === option.value} onChange={() => updateProfile(option.value)} />
            <span><strong>{option.label}</strong><small>{option.hint}</small></span>
          </label>
          <InfoTooltip label={`About ${option.label} access`}>{option.details}</InfoTooltip>
        </div>)}
      </div>
    </fieldset>
    <fieldset className="assistant-access-field" disabled={disabled}>
      <legend>Platforms</legend>
      <div className="assistant-platform-mode">
        <label className="assistant-radio-card"><input type="radio" name="tool_platform_mode" value="all" checked={providers === null} onChange={() => updatePlatforms(null)} /><span>All platforms</span></label>
        <label className="assistant-radio-card"><input type="radio" name="tool_platform_mode" value="selected" checked={providers !== null} onChange={() => updatePlatforms(chosen)} /><span>Choose platforms</span></label>
      </div>
      {providers !== null ? <div className="tool-platform-options assistant-platform-options">{platformOptions}</div> : null}
      {providers?.length === 0 ? <p className="field-hint">No platform tools will be available.</p> : null}
    </fieldset>
  </div>;
  return <div className="tool-catalog-fields">
    <div className="field">
      <span className="field-label">Tool access</span>
      <Select name="tool_profile" aria-label="Tool access" options={TOOL_PROFILE_OPTIONS} value={profile}
        disabled={disabled} onValueChange={value => updateProfile(value as ToolSelection['profile'])} />
      <span className="field-hint">{TOOL_PROFILE_DESCRIPTIONS[profile]}</span>
    </div>
    <Disclosure className="tool-platform-disclosure" label="What’s included in each profile">
      <dl className="tool-profile-features">
        <div><dt>Reporting</dt><dd>Read performance and inspect accounts, campaign settings, audiences and conversion configuration. Changes are unavailable.</dd></div>
        <div><dt>Standard</dt><dd>Everyday reporting and campaign management: create campaigns and ads, change budgets and status, upload creatives, manage Google keywords and Meta targeting.</dd></div>
        <div><dt>Full</dt><dd>Add advanced workflows supported by your selected platforms: Google experiments, conversion setup and offline uploads; Meta custom, website and lookalike audiences; and other platform-specific operations.</dd></div>
      </dl>
      <p className="field-hint">Platforms determine which tools you receive. Your role, account access and plan still apply. Every ad change starts with a preview.</p>
    </Disclosure>
    <p className="field-hint">Missing a capability? Ask your assistant to check Adport capabilities. It can explain which profile or platform to enable and link you here. After saving, refresh tools in your assistant; reconnect if its tool list stays unchanged.</p>
    <input type="hidden" name="tool_platform_mode" value={providers === null ? 'all' : 'selected'} />
    <Disclosure className="tool-platform-disclosure" label={`Platforms · ${providers === null ? 'All platforms' : providers.length ? providers.map(providerLabel).join(', ') : 'None selected'}`}>
      <label className="tool-platform-option"><Checkbox disabled={disabled} checked={providers === null}
        onChange={event => updatePlatforms(event.target.checked ? null : chosen)} /><span>Include all current and future platforms</span></label>
      <fieldset className="tool-platform-options" disabled={disabled || providers === null}>
        <legend className="sr-only">Platforms available to this assistant</legend>
        {platformOptions}
      </fieldset>
      <p className="field-hint">Only selected platforms have tools in this connection. Accounts still need to be connected and enabled in each project.</p>
    </Disclosure>
  </div>;
}
