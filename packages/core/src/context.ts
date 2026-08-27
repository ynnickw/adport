import { auditTools } from './audit/tools.js';
import { CredentialStore } from './credentials/store.js';
import { PolicyEngine } from './policy/engine.js';
import { loadPolicy } from './policy/policy.js';
import { ProviderRegistry, type AdProvider } from './provider.js';
import { builtinTools } from './tools/builtin.js';
import { ToolRegistry, type AnyToolDefinition, type ToolContext } from './tools/registry.js';
import { MockProvider, mockTools } from './testing/mock-provider.js';
import type { FindingsRepository } from './audit/store.js';

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
}

export interface AdportRuntime {
  ctx: ToolContext;
  registry: ToolRegistry;
  policySource: string;
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
  };
  ctx.registry = registry;
  return { ctx, registry, policySource: source };
}
