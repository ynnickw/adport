import { auditTools } from './audit/tools.js';
import { FindingsStore, type FindingsRepository } from './audit/store.js';
import { AuditLog, type AuditRepository } from './policy/audit.js';
import { CredentialStore, type CredentialRepository } from './credentials/store.js';
import { PolicyEngine } from './policy/engine.js';
import { loadPolicy, type Policy } from './policy/policy.js';
import { PendingStore, type PendingRepository } from './policy/pending.js';
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
  policy?: Policy;
  credentials?: CredentialRepository;
  pending?: PendingRepository;
  audit?: AuditRepository;
  findings?: FindingsRepository;
  /** Extra providers with their tools (e.g. the Google provider from @adport/provider-google). */
  providerModules?: ProviderModule[];
  /**
   * Include the credential-free mock provider. Disabled by default so a
   * misconfigured live runtime cannot silently substitute synthetic accounts.
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
  const includeMock = options.includeMock ?? false;

  const providers = new ProviderRegistry();
  const loaded = options.policy ? { policy: options.policy, source: 'injected' } : await loadPolicy(options.policyPath);
  const engine = new PolicyEngine(loaded.policy, options.pending ?? new PendingStore(), options.audit ?? new AuditLog());
  const credentials = options.credentials ?? new CredentialStore();
  const findings = options.findings ?? new FindingsStore();

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

  const ctx: ToolContext = { providers, engine, credentials, findings };
  ctx.registry = registry;
  return { ctx, registry, policySource: loaded.source };
}
