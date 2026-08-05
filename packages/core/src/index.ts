export { AdportError, type AdportErrorCode } from './errors.js';
export { adportHome } from './paths.js';
export {
  METRICS,
  ENTITY_LEVELS,
  DATE_PRESETS,
  resolveDateRange,
  rangeDayCount,
  type MetricName,
  type EntityLevel,
  type DatePreset,
  type DateRange,
  type NormalizedQuery,
  type Report,
  type ReportRow,
} from './model.js';
export {
  ProviderRegistry,
  type Account,
  type AdProvider,
  type BudgetDelta,
  type ProviderCapabilities,
  type WriteGuard,
  type WriteKind,
  type WriteOperation,
  type WritePreview,
  type WriteResult,
} from './provider.js';
export { CredentialStore, type CredentialRecord, type CredentialSource } from './credentials/store.js';
export { policySchema, loadPolicy, DEFAULT_POLICY, type Policy, type LoadedPolicy } from './policy/policy.js';
export { PendingStore, type PendingOperation } from './policy/pending.js';
export { AuditLog, type AuditEntry } from './policy/audit.js';
export { PolicyEngine, hashOperation, type ApplyOutcome, type ValidationOutcome } from './policy/engine.js';
export {
  ToolRegistry,
  defineTool,
  type AnyToolDefinition,
  type ToolAnnotations,
  type ToolContext,
} from './tools/registry.js';
export { guardedWriteTool } from './tools/write.js';
export { builtinTools } from './tools/builtin.js';
export { MockProvider, mockTools } from './testing/mock-provider.js';
export {
  createContext,
  type AdportRuntime,
  type CreateContextOptions,
  type ProviderModule,
} from './context.js';
