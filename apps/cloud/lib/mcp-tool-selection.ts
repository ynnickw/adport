import { TOOL_PROVIDERS, type ToolSelection } from '@adport/core/tool-catalog';
import { z } from 'zod';

export const toolSelectionSchema = z.object({
  profile: z.enum(['standard', 'reporting', 'full']),
  providers: z.array(z.enum(TOOL_PROVIDERS)).max(TOOL_PROVIDERS.length).transform(values => [...new Set(values)]).nullable(),
});
export const LEGACY_TOOL_SELECTION: ToolSelection = { profile: 'full', providers: null };
export const TOOL_PROFILE_OPTIONS = [
  { value: 'standard', label: 'Standard' },
  { value: 'reporting', label: 'Reporting' },
  { value: 'full', label: 'Full' },
];
export const TOOL_PROFILE_DESCRIPTIONS = {
  standard: 'Performance reports, campaigns, budgets, ads and creative uploads.',
  reporting: 'Read-only access to performance, account inspection and available configuration.',
  full: 'All supported tools for your selected platforms, including advanced workflows.',
};

export function toolSelectionFromForm(form: FormData): ToolSelection {
  return toolSelectionSchema.parse({
    profile: form.get('tool_profile') ?? 'standard',
    providers: form.get('tool_platform_mode') === 'all' ? null : form.getAll('tool_providers'),
  });
}
