import { z } from 'zod';
import { AdportError } from './errors.js';
import { analyticsTools } from './tools/acquisition.js';
import { CAMPAIGN_PROVIDERS, campaignMapping, type CampaignProvider } from './tools/campaign-mappings.js';
import { campaignTools } from './tools/campaigns.js';
import { auditTools } from './audit/tools.js';
import { CredentialStore } from './credentials/store.js';
import { PolicyEngine } from './policy/engine.js';
import { loadPolicy } from './policy/policy.js';
import { ProviderRegistry, type AdProvider } from './provider.js';
import { builtinTools } from './tools/builtin.js';
import { ToolRegistry, type AnyToolDefinition, type ToolContext } from './tools/registry.js';
import { MockProvider, mockTools } from './testing/mock-provider.js';
import type { FindingsRepository } from './audit/store.js';
import { mediaTools } from './tools/media.js';
import type { MediaLibrary } from './media.js';
import { ANALYTICS_PROVIDERS, toolInSelection, type ToolProvider, type ToolSelection } from './tools/catalog.js';
import { capabilityTools } from './tools/capabilities.js';
import type { ToolCatalogContext } from './tools/registry.js';

export interface ProviderModule {
  provider: AdProvider;
  tools: AnyToolDefinition[];
}

export interface CreateContextOptions {
  policyPath?: string;
  /** Extra providers with their tools (e.g. the Google provider from @adport/provider-google). */
  providerModules?: ProviderModule[];
  /** Platforms this host can connect, including those with no credentials yet. */
  capabilityProviders?: readonly ToolProvider[];
  /** A hosted multi-project catalog may describe available website platforms before connection. */
  analyticsProviders?: readonly typeof ANALYTICS_PROVIDERS[number][];
  /** Hosted catalogs can advertise providers which a different selected project may have connected. */
  campaignProviders?: readonly CampaignProvider[];
  /**
   * Include the credential-free mock provider. Disabled by default so a
   * misconfigured live runtime cannot silently substitute synthetic accounts.
   */
  includeMock?: boolean;
  /** Hosted runtimes inject a tenant-scoped engine with durable database stores. */
  engine?: PolicyEngine;
  /** Optional hosted authorization boundary executed before every tool handler. */
  authorizeToolCall?: ToolContext['authorizeToolCall'];
  /** Hosted runtimes inject tenant-scoped finding persistence. */
  findings?: FindingsRepository;
  media?: MediaLibrary;
}

export interface AdportRuntime {
  /** Set only by an isolated, server-provisioned reviewer runtime. */
  dataSource?: 'synthetic';
  ctx: ToolContext;
  registry: ToolRegistry;
  policySource: string;
}

function toolForSelection(tool: AnyToolDefinition, selection: ToolSelection): AnyToolDefinition {
  if (!tool.sourceProviders || !selection.providers) return tool;
  const sources = tool.sourceProviders.filter(id => selection.providers!.includes(id));
  return { ...tool, sourceProviders: sources, input: tool.input.safeExtend({ provider: z.enum(sources) }) };
}

/** Filter execution as well as discovery; shared reads also see only selected providers. */
export function selectRuntimeCatalog(runtime: AdportRuntime, selection: ToolSelection, includeRawTools = false,
  discovery: Pick<ToolCatalogContext, 'canWrite' | 'manageAccessUrl' | 'excludedTools'> = {}): AdportRuntime {
  const registry = new ToolRegistry();
  registry.register(runtime.registry.list().filter(tool => toolInSelection(tool, selection, includeRawTools)).map(tool => toolForSelection(tool, selection)));
  // Keep transport instrumentation and the owning registry's validation path.
  registry.call = async (name, input, ctx) => {
    const tool = registry.get(name);
    if (tool.sourceProviders && input && typeof input === 'object' && 'provider' in input && !tool.sourceProviders.some(id => id === input.provider)) {
      throw new AdportError('NOT_CONNECTED', 'This platform is unavailable in the selected connection.');
    }
    return runtime.registry.call(name, input, ctx);
  };
  const providers = new ProviderRegistry();
  for (const provider of runtime.ctx.providers.list()) {
    if (selection.providers === null || selection.providers.some(id => id === provider.id)) providers.register(provider);
  }
  return { ...runtime, registry, ctx: { ...runtime.ctx, providers, registry,
    catalog: { ...(runtime.ctx.catalog ?? { tools: runtime.registry.list(), selection,
      connectedProviders: runtime.ctx.providers.list().map(provider => provider.id) }), ...discovery,
      includeRawTools: includeRawTools && (runtime.ctx.catalog?.includeRawTools ?? true),
      canWrite: runtime.ctx.catalog?.canWrite === false ? false : discovery.canWrite ?? runtime.ctx.catalog?.canWrite },
    authorizeToolCall: (tool, input) => runtime.ctx.authorizeToolCall?.(tool, input),
  } };
}

export function createToolRegistry(options: Pick<CreateContextOptions, 'providerModules' | 'analyticsProviders' | 'campaignProviders' | 'capabilityProviders' | 'includeMock'> = {}): ToolRegistry {
  const modules = options.providerModules ?? [];
  const registry = new ToolRegistry();
  registry.register(builtinTools());
  registry.register(capabilityTools(options.capabilityProviders));
  registry.register(mediaTools());
  registry.register(auditTools());

  for (const module of modules) {
    registry.register(module.tools);
  }
  const sources = options.analyticsProviders ?? ANALYTICS_PROVIDERS.filter(id => modules.some(m => m.provider.id === id && m.provider.acquisitionAnalytics));
  registry.register(analyticsTools(sources));
  const campaignSources = options.campaignProviders ?? CAMPAIGN_PROVIDERS.filter(id => modules.some(module =>
    module.provider.id === id && module.tools.some(tool => tool.name === campaignMapping(id).list)));
  const writableCampaignSources = campaignSources.filter(id => {
    const module = modules.find(entry => entry.provider.id === id);
    return !module || module.tools.some(tool => tool.name === id + '_set_campaign_status' && tool.annotations.readOnly === false);
  });
  registry.register(campaignTools(registry, campaignSources, writableCampaignSources));
  if (options.includeMock) registry.register(mockTools());
  return registry;
}

export async function createContext(options: CreateContextOptions = {}): Promise<AdportRuntime> {
  const providers = new ProviderRegistry();
  const { policy, source } = await loadPolicy(options.policyPath);
  const engine = options.engine ?? new PolicyEngine(policy);
  const credentials = new CredentialStore();
  const registry = createToolRegistry(options);
  for (const module of options.providerModules ?? []) providers.register(module.provider);
  if (options.includeMock) providers.register(new MockProvider());
  const ctx: ToolContext = {
    providers,
    engine,
    credentials,
    authorizeToolCall: options.authorizeToolCall,
    findings: options.findings,
    media: options.media,
  };
  ctx.registry = registry;
  return { ctx, registry, policySource: source };
}
