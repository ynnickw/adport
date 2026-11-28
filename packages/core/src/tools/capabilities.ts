import { z } from 'zod';
import { classifyTool, isTrackingSource, TOOL_CATEGORIES, TOOL_PROVIDERS, toolInSelection, type ToolCatalogMetadata, type ToolProvider } from './catalog.js';
import { standardCampaignReplacement } from './campaign-mappings.js';
import { defineTool, type AnyToolDefinition } from './registry.js';

const categories = Object.keys(TOOL_CATEGORIES) as [ToolCatalogMetadata['category'], ...ToolCatalogMetadata['category'][]];
const blocker = z.enum(['platform_disabled', 'not_connected', 'profile_disabled', 'write_permission_required']);

export function capabilityTools(providers: readonly ToolProvider[] = TOOL_PROVIDERS): AnyToolDefinition[] {
  return [defineTool({
    name: 'capabilities_list', namespace: 'core',
    description: 'Look up availability and access requirements for named Adport tools. Returns connection settings and status; this lookup changes no settings and executes no operations.',
    input: z.object({
      query: z.string().trim().min(1).max(200).optional().describe('Keywords such as lookalike, offline conversions, experiments, or an exact tool name.'),
      provider: z.enum(providers).optional(),
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
      const matches = source.filter(tool => (!input.provider || tool.namespace === input.provider || tool.sourceProviders?.includes(input.provider))
        && (!input.category || (tool.catalog ?? classifyTool(tool.name, tool.namespace)).category === input.category))
        .map(tool => {
          const description = catalog?.manageAccessUrl ? tool.hosted?.description ?? tool.description : tool.description;
          const text = `${tool.name.replaceAll('_', ' ')} ${description}`.toLowerCase();
          return { tool, description, score: tokens.reduce((score, word) => score + (text.includes(word) ? 1 : 0), 0) };
        }).filter(item => !tokens.length || item.score > 0)
        .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name));
      const tools = matches.map(({ tool, description }) => {
        const metadata = tool.catalog ?? classifyTool(tool.name, tool.namespace);
        const platforms = tool.sourceProviders
          ? input.provider ? [input.provider] : tool.sourceProviders
          : TOOL_PROVIDERS.filter(id => id === tool.namespace);
        const selected = platforms.filter(id => selection.providers === null || selection.providers.includes(id));
        const target = input.provider ?? (tool.sourceProviders ? (selected.length ? selected : platforms).join(' or ') : tool.namespace);
        const blockers: z.infer<typeof blocker>[] = [];
        const next_steps: string[] = [];
        if (platforms.length > 0 && !selected.length) {
          blockers.push('platform_disabled'); next_steps.push(`Select ${target} under Platforms in this connection’s Tool access settings.`);
        }
        if (platforms.length > 0 && !(selected.length ? selected : platforms).some(id => connected.has(id))) {
          blockers.push('not_connected');
          next_steps.push(tool.namespace === 'analytics' || isTrackingSource(tool.namespace)
            ? `Connect ${target} under Analytics & tracking and enable the sources this assistant can read.`
            : `Connect ${target} in this project, then enable its accounts under Accounts.`);
        }
        if (!toolInSelection(tool, { ...selection, providers: null }, catalog?.includeRawTools)) {
          blockers.push('profile_disabled');
          const shared = selection.profile === 'standard' && standardCampaignReplacement(tool.name);
          if (shared && source.some(candidate => candidate.name === shared
            && candidate.sourceProviders?.some(id => id === tool.namespace)
            && toolInSelection(candidate, selection, catalog?.includeRawTools))) {
            next_steps.push('Use ' + shared + ' with provider ' + tool.namespace + ' for the shared campaign workflow.');
          }
          next_steps.push(`Choose ${tool.annotations.readOnly ? 'Reporting (read-only) or Full' : metadata.exposure === 'standard' ? 'Standard or Full' : 'Full'} under Tool access for this connection.`);
        }
        if (!tool.annotations.readOnly && catalog?.canWrite === false) {
          blockers.push('write_permission_required'); next_steps.push('Ask a project owner to review this connection’s write permissions, your role and plan. Changing the tool profile alone does not grant write access.');
        }
        return { name: tool.name, provider: input.provider ?? tool.namespace, category: metadata.category, description: description.slice(0, 220),
          read_only: tool.annotations.readOnly === true, enabled: blockers.length === 0, blockers, next_steps };
      });
      return {
        profile: selection.profile, selected_providers: selection.providers,
        platforms: providers.map(id => ({ id, selected: selection.providers === null || selection.providers.includes(id), connected: connected.has(id) })),
        categories: categories.map(id => {
          const group = tools.filter(tool => tool.category === id);
          return { id, label: TOOL_CATEGORIES[id], enabled_tools: group.filter(tool => tool.enabled).length, disabled_tools: group.filter(tool => !tool.enabled).length };
        }).filter(group => group.enabled_tools + group.disabled_tools > 0),
        tools: tools.slice(0, input.limit), total_matches: tools.length, truncated: tools.length > input.limit,
        ...(catalog?.manageAccessUrl ? { manage_access_url: catalog.manageAccessUrl } : {}),
        instructions: 'Use the returned access status and settings link to explain availability. Call operations only through the tools listed by this connection. Account access, provider eligibility, and write approval still apply.',
      };
    },
  })];
}
