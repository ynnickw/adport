import { z } from 'zod';
import { classifyTool, TOOL_CATEGORIES, TOOL_PROVIDERS, toolInSelection, type ToolCatalogMetadata, type ToolProvider } from './catalog.js';
import { defineTool, type AnyToolDefinition } from './registry.js';

const categories = Object.keys(TOOL_CATEGORIES) as [ToolCatalogMetadata['category'], ...ToolCatalogMetadata['category'][]];
const blocker = z.enum(['platform_disabled', 'not_connected', 'profile_disabled', 'write_permission_required']);

export function capabilityTools(): AnyToolDefinition[] {
  return [defineTool({
    name: 'capabilities_list', namespace: 'core',
    description: 'Discover supported workflows, including tools hidden by this connection’s profile or platforms. Search keywords or a tool name before claiming a task is unsupported. Returns enablement steps and a settings link; never changes access or runs hidden tools.',
    input: z.object({
      query: z.string().trim().min(1).max(200).optional().describe('Keywords such as lookalike, offline conversions, experiments, or an exact tool name.'),
      provider: z.enum(TOOL_PROVIDERS).optional(),
      category: z.enum(categories).optional(),
      limit: z.number().int().positive().max(30).default(10),
    }),
    output: z.object({
      profile: z.enum(['standard', 'reporting', 'full']), selected_providers: z.array(z.string()).nullable(),
      platforms: z.array(z.object({ id: z.string(), selected: z.boolean(), connected: z.boolean() })),
      categories: z.array(z.object({ id: z.string(), label: z.string(), enabled_tools: z.number().int(), disabled_tools: z.number().int() })),
      tools: z.array(z.object({
        name: z.string(), provider: z.string(), category: z.string(), description: z.string(), read_only: z.boolean(),
        enabled: z.boolean(), blockers: z.array(blocker), next_steps: z.array(z.string()),
      })),
      total_matches: z.number().int(), truncated: z.boolean(), manage_access_url: z.url().optional(), instructions: z.string(),
    }),
    annotations: { readOnly: true, openWorld: false },
    async handler(input, ctx) {
      const catalog = ctx.catalog;
      const selection = catalog?.selection ?? { profile: 'full' as const, providers: null };
      const connected = new Set(catalog?.connectedProviders ?? ctx.providers.list().map(provider => provider.id));
      const source = (catalog?.tools ?? ctx.registry?.list() ?? []).filter(tool =>
        !catalog?.excludedTools?.includes(tool.name) && ((tool.catalog ?? classifyTool(tool.name, tool.namespace)).exposure !== 'raw' || catalog?.includeRawTools));
      const tokens = (input.query?.toLowerCase().match(/[a-z0-9]+/g) ?? [])
        .filter(word => !['a', 'an', 'the', 'to', 'for', 'and', 'with', 'my', 'how', 'can', 'i'].includes(word))
        .map(word => word.length > 4 && word.endsWith('s') ? word.slice(0, -1) : word);
      const matches = source.filter(tool => (!input.provider || tool.namespace === input.provider)
        && (!input.category || (tool.catalog ?? classifyTool(tool.name, tool.namespace)).category === input.category))
        .map(tool => {
          const text = `${tool.name.replaceAll('_', ' ')} ${tool.description}`.toLowerCase();
          return { tool, score: tokens.reduce((score, word) => score + (text.includes(word) ? 1 : 0), 0) };
        }).filter(item => !tokens.length || item.score > 0)
        .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name));
      const tools = matches.map(({ tool }) => {
        const metadata = tool.catalog ?? classifyTool(tool.name, tool.namespace);
        const platformTool = TOOL_PROVIDERS.includes(tool.namespace as ToolProvider);
        const blockers: z.infer<typeof blocker>[] = [];
        const next_steps: string[] = [];
        if (platformTool && selection.providers !== null && !selection.providers.includes(tool.namespace as ToolProvider)) {
          blockers.push('platform_disabled'); next_steps.push(`Select ${tool.namespace} under Platforms in this connection’s Tool access settings.`);
        }
        if (platformTool && !connected.has(tool.namespace)) {
          blockers.push('not_connected'); next_steps.push(`Connect ${tool.namespace} in this project, then enable its accounts under Accounts.`);
        }
        if (!toolInSelection(tool, { ...selection, providers: null }, catalog?.includeRawTools)) {
          blockers.push('profile_disabled');
          next_steps.push(`Choose ${metadata.exposure === 'standard' ? 'Standard or Full' : 'Full'} under Tool access for this connection.`);
        }
        if (!tool.annotations.readOnly && catalog?.canWrite === false) {
          blockers.push('write_permission_required'); next_steps.push('Ask a project owner to review this connection’s write permissions, your role and plan. Changing the tool profile alone does not grant write access.');
        }
        return { name: tool.name, provider: tool.namespace, category: metadata.category, description: tool.description.slice(0, 220),
          read_only: tool.annotations.readOnly === true, enabled: blockers.length === 0, blockers, next_steps };
      });
      return {
        profile: selection.profile, selected_providers: selection.providers,
        platforms: TOOL_PROVIDERS.map(id => ({ id, selected: selection.providers === null || selection.providers.includes(id), connected: connected.has(id) })),
        categories: categories.map(id => {
          const group = tools.filter(tool => tool.category === id);
          return { id, label: TOOL_CATEGORIES[id], enabled_tools: group.filter(tool => tool.enabled).length, disabled_tools: group.filter(tool => !tool.enabled).length };
        }).filter(group => group.enabled_tools + group.disabled_tools > 0),
        tools: tools.slice(0, input.limit), total_matches: tools.length, truncated: tools.length > input.limit,
        ...(catalog?.manageAccessUrl ? { manage_access_url: catalog.manageAccessUrl } : {}),
        instructions: 'Supported tools can be hidden by the profile or platform selection. Explain the returned blockers and link to Manage tool access. After saving access, refresh tools in the assistant; reconnect if its tool list stays unchanged. Never call a hidden tool or infer that its workflow is unsupported. Enabled tools still require account access and native platform eligibility; use accounts_list. Writes still require preview and approval.',
      };
    },
  })];
}
