import { AdportError } from './errors.js';
import type { NormalizedQuery, Report } from './model.js';

export interface Account {
  provider: string;
  id: string;
  name: string;
  currency?: string;
  status?: string;
}

export type WriteKind = 'create' | 'update' | 'remove';

export interface WriteOperation {
  /** Tool name that produced this operation — part of the audit trail. */
  tool: string;
  provider: string;
  accountId: string;
  kind: WriteKind;
  payload: Record<string, unknown>;
}

export interface BudgetDelta {
  /** Human-readable target, e.g. "campaign c1 daily budget". */
  target: string;
  fromMicros?: number;
  toMicros: number;
}

export interface WritePreview {
  summary: string;
  changes: string[];
  /** Adjustments the guard forced (e.g. "status coerced to PAUSED"). Never silent. */
  coercions: string[];
  budgetDeltas: BudgetDelta[];
  /** True when the platform validated the operation server-side (dry run). */
  serverValidated: boolean;
}

export interface WriteResult {
  applied: true;
  resourceIds: string[];
  details?: unknown;
}

/** Policy-derived constraints handed to providers on every preview/apply. */
export interface WriteGuard {
  forcePausedCreation: boolean;
}

export interface ProviderCapabilities {
  serverDryRun: boolean;
}

/** A ready-to-call tool invocation (flows through the normal validate→apply gate). */
export interface StandardAction {
  tool: string;
  input: Record<string, unknown>;
}

/**
 * Provider-declared mappings for cross-platform actions the audit harness can
 * propose (each provider knows its own tool names and native status values).
 */
export interface StandardActions {
  pauseCampaign?: (accountId: string, campaignId: string) => StandardAction;
}

export interface AdProvider {
  readonly id: string;
  capabilities(): ProviderCapabilities;
  listAccounts(): Promise<Account[]>;
  report(query: NormalizedQuery): Promise<Report>;
  /** Dry-run the operation (server-side where supported, client-side diff otherwise). */
  previewWrite(op: WriteOperation, guard: WriteGuard): Promise<WritePreview>;
  /** Execute the operation for real. Only the policy engine may call this. */
  applyWrite(op: WriteOperation, guard: WriteGuard): Promise<WriteResult>;
  /** Optional cross-platform action mappings used by the recommendation harness. */
  standardActions?(): StandardActions;
}

export class ProviderRegistry {
  private providers = new Map<string, AdProvider>();

  register(provider: AdProvider): void {
    this.providers.set(provider.id, provider);
  }

  get(id: string): AdProvider {
    const provider = this.providers.get(id);
    if (!provider) {
      throw new AdportError(
        'NOT_CONNECTED',
        `Provider "${id}" is not connected. Run \`adport connect ${id}\` first.`,
      );
    }
    return provider;
  }

  list(): AdProvider[] {
    return [...this.providers.values()];
  }
}
