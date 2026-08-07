import { auditTools } from './audit/tools.js';
import { CredentialStore } from './credentials/store.js';
import { PolicyEngine } from './policy/engine.js';
import { loadPolicy } from './policy/policy.js';
import { ProviderRegistry, type AdProvider } from './provider.js';
import { builtinTools } from './tools/builtin.js';
import { ToolRegistry, type AnyToolDefinition, type ToolContext } from './tools/registry.js';
import { MockProvider, mockTools } from './testing/mock-provider.js';

export interface ProviderModule {
  provider: AdProvider;
  tools: AnyToolDefinition[];
}

export interface CreateContextOptions {
  policyPath?: string;
  /** Extra providers with their tools (e.g. the Google provider from @adport/provider-google). */
  providerModules?: ProviderModule[];
  /**
   * Include the credential-free mock provider. Defaults to true when no real
   * provider module is passed, so a fresh install always has something to try.
   */
  includeMock?: boolean;
}

export interface AdportRuntime {
  ctx: ToolContext;
  registry: ToolRegistry;
  policySource: string;
}

export async function createContext(options: CreateContextOptions = {}): Promise<AdportRuntime> {
  const modules = options.providerModules ?? [];
  const includeMock = options.includeMock ?? modules.length === 0;

  const providers = new ProviderRegistry();
  const { policy, source } = await loadPolicy(options.policyPath);
  const engine = new PolicyEngine(policy);
  const credentials = new CredentialStore();

  const registry = new ToolRegistry();
  registry.register(builtinTools());
  registry.register(auditTools());

  for (const module of modules) {
    providers.register(module.provider);
    registry.register(module.tools);
  }
  if (includeMock) {
    providers.register(new MockProvider());
    registry.register(mockTools());
  }

  const ctx: ToolContext = { providers, engine, credentials };
  ctx.registry = registry;
  return { ctx, registry, policySource: source };
}
