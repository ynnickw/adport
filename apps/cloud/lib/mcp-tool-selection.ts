import { TOOL_PROVIDERS, toolInSelection, type ToolProvider, type ToolSelection } from '@adport/core/tool-catalog';
import { CLOUD_PROVIDERS } from './cloud/types';
import { z } from 'zod';

export const toolSelectionSchema = z.object({
  profile: z.enum(['standard', 'reporting', 'full']),
  providers: z.array(z.enum(CLOUD_PROVIDERS)).max(CLOUD_PROVIDERS.length).transform(values => [...new Set(values)]).nullable(),
});
export const LEGACY_TOOL_SELECTION: ToolSelection = { profile: 'full', providers: null };
export const TOOL_PROFILE_OPTIONS = [
  { value: 'reporting', label: 'Reporting', details: 'Read-only access to performance, accounts, campaigns, audiences, and conversion settings.' },
  { value: 'standard', label: 'Standard', details: 'Includes Reporting plus everyday campaign tools. Propose changes to ads, budgets, keywords, or targeting where supported.' },
  { value: 'full', label: 'Full', details: 'Includes Standard plus advanced tools where supported, such as Google Ads experiments, conversion imports, and Meta custom audiences. Existing permissions and approval rules still apply.' },
] as const;

export interface ToolCatalogCountGroup {
  providers: readonly ToolProvider[];
  counts: Record<ToolSelection['profile'], { read: number; write: number }>;
}

export function summarizeToolCatalog(tools: ReadonlyArray<Parameters<typeof toolInSelection>[0]>): ToolCatalogCountGroup[] {
  const groups = new Map<string, ToolCatalogCountGroup>();
  for (const tool of tools) {
    if (tool.name === 'recommendation_apply' || !toolInSelection(tool, { profile: 'full', providers: null })) continue;
    const providers = tool.sourceProviders ?? TOOL_PROVIDERS.filter(id => id === tool.namespace);
    const key = [...providers].sort().join(',');
    let group = groups.get(key);
    if (!group) {
      group = { providers, counts: { standard: { read: 0, write: 0 }, reporting: { read: 0, write: 0 }, full: { read: 0, write: 0 } } };
      groups.set(key, group);
    }
    for (const profile of ['standard', 'reporting', 'full'] as const) {
      if (toolInSelection(tool, { profile, providers: null })) group.counts[profile][tool.annotations.readOnly ? 'read' : 'write']++;
    }
  }
  return [...groups.values()];
}

export function catalogToolCount(groups: readonly ToolCatalogCountGroup[], selection: ToolSelection,
  scopes: readonly string[], projectDiscovery = false): number {
  const read = scopes.includes('tools:read'), write = scopes.includes('tools:write');
  let count = projectDiscovery && read ? 1 : 0;
  for (const group of groups) {
    if (selection.providers && group.providers.length && !group.providers.some(id => selection.providers?.includes(id))) continue;
    const available = group.counts[selection.profile];
    count += (read ? available.read : 0) + (write ? available.write : 0);
  }
  return count;
}

export function standardToolSelection(current: ToolSelection, connected: readonly ToolProvider[] = []): ToolSelection {
  return { profile: 'standard', providers: current.providers ?? (connected.length ? connected : null) };
}

export function toolSelectionFromForm(form: FormData): ToolSelection {
  return toolSelectionSchema.parse({
    profile: form.get('tool_profile') ?? 'standard',
    providers: form.get('tool_platform_mode') === 'all' ? null : form.getAll('tool_providers'),
  });
}
