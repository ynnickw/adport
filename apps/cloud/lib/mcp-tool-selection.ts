import { type ToolSelection } from '@adport/core/tool-catalog';
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

export function toolSelectionFromForm(form: FormData): ToolSelection {
  return toolSelectionSchema.parse({
    profile: form.get('tool_profile') ?? 'standard',
    providers: form.get('tool_platform_mode') === 'all' ? null : form.getAll('tool_providers'),
  });
}
