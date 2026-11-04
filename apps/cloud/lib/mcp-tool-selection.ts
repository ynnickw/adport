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
  standard: 'Everyday reporting and campaign workflows. Specialist tools stay out of the way.',
  reporting: 'Read-only tools for performance, account inspection and audits.',
  full: 'Every supported operation, including specialist workflows.',
};

export function toolSelectionFromForm(form: FormData): ToolSelection {
  return toolSelectionSchema.parse({
    profile: form.get('tool_profile') ?? 'standard',
    providers: form.get('tool_platform_mode') === 'all' ? null : form.getAll('tool_providers'),
  });
}
