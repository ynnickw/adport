'use client';

import { useState } from 'react';
import { TOOL_PROVIDERS, type ToolSelection, type ToolProvider } from '@adport/core/tool-catalog';
import { Checkbox, Disclosure } from './controls';
import { Select } from './select';
import { providerLabel } from '@/lib/cloud/providers';
import { TOOL_PROFILE_DESCRIPTIONS, TOOL_PROFILE_OPTIONS } from '@/lib/mcp-tool-selection';

export function ToolCatalogFields({ initialSelection, disabled = false }: { initialSelection: ToolSelection; disabled?: boolean }) {
  const [profile, setProfile] = useState(initialSelection.profile);
  const [providers, setProviders] = useState<readonly ToolProvider[] | null>(initialSelection.providers);
  const [chosen, setChosen] = useState<readonly ToolProvider[]>(initialSelection.providers ?? []);
  function toggle(provider: ToolProvider, checked: boolean) {
    const next = checked ? [...chosen, provider] : chosen.filter(value => value !== provider);
    setChosen(next); setProviders(next);
  }
  return <div className="tool-catalog-fields">
    <div className="field">
      <span className="field-label">Tool access</span>
      <Select name="tool_profile" aria-label="Tool access" options={TOOL_PROFILE_OPTIONS} value={profile}
        disabled={disabled} onValueChange={value => setProfile(value as ToolSelection['profile'])} />
      <span className="field-hint">{TOOL_PROFILE_DESCRIPTIONS[profile]}</span>
    </div>
    <input type="hidden" name="tool_platform_mode" value={providers === null ? 'all' : 'selected'} />
    <Disclosure className="tool-platform-disclosure" label={`Platforms · ${providers === null ? 'All platforms' : providers.length ? providers.map(providerLabel).join(', ') : 'None selected'}`}>
      <label className="tool-platform-option"><Checkbox disabled={disabled} checked={providers === null}
        onChange={event => setProviders(event.target.checked ? null : chosen)} /><span>Include all current and future platforms</span></label>
      <fieldset className="tool-platform-options" disabled={disabled || providers === null}>
        <legend className="sr-only">Platforms available to this assistant</legend>
        {TOOL_PROVIDERS.map(provider => <label className="tool-platform-option" key={provider}>
          <Checkbox name="tool_providers" value={provider} checked={providers === null || chosen.includes(provider)}
            onChange={event => toggle(provider, event.target.checked)} /><span>{providerLabel(provider)}</span>
        </label>)}
      </fieldset>
      <p className="field-hint">Only selected platforms have tools in this connection. Accounts still need to be connected and enabled in each project.</p>
    </Disclosure>
  </div>;
}
