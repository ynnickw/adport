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
import { toolInSelection, type ToolSelection } from './tools/catalog.js';
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

/** Filter execution as well as discovery; shared reads also see only selected providers. */
export function selectRuntimeCatalog(runtime: AdportRuntime, selection: ToolSelection, includeRawTools = false,
  discovery: Pick<ToolCatalogContext, 'canWrite' | 'manageAccessUrl' | 'excludedTools'> = {}): AdportRuntime {
  const registry = new ToolRegistry();
  registry.register(runtime.registry.list().filter(tool => toolInSelection(tool, selection, includeRawTools)));
  // Keep transport instrumentation and the owning registry's validation path.
  registry.call = async (name, input, ctx) => {
    registry.get(name);
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

export async function createContext(options: CreateContextOptions = {}): Promise<AdportRuntime> {
  const modules = options.providerModules ?? [];
  const includeMock = options.includeMock ?? false;

  const providers = new ProviderRegistry();
  const { policy, source } = await loadPolicy(options.policyPath);
  const engine = options.engine ?? new PolicyEngine(policy);
  const credentials = new CredentialStore();

  const registry = new ToolRegistry();
  registry.register(builtinTools());
  registry.register(capabilityTools());
  registry.register(mediaTools());
  registry.register(auditTools());

  for (const module of modules) {
    providers.register(module.provider);
    registry.register(module.tools);
  }
  if (includeMock) {
    providers.register(new MockProvider());
    registry.register(mockTools());
  }

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
