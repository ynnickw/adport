import { createHash, randomUUID } from 'node:crypto';
import { AdportError } from '../errors.js';
import type { AdProvider, WriteGuard, WriteOperation, WritePreview, WriteResult } from '../provider.js';
import { AuditLog, type AuditRepository } from './audit.js';
import { PendingStore, type PendingRepository } from './pending.js';
import type { Policy } from './policy.js';

export interface ValidationOutcome {
  pendingOperationId: string;
  preview: WritePreview;
  expiresAt: string;
}

export interface ApplyOutcome {
  result: WriteResult;
  preview: WritePreview;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonicalize(v)]),
    );
  }
  return value;
}

export function hashOperation(op: WriteOperation): string {
  const canonical = canonicalize({
    tool: op.tool,
    provider: op.provider,
    accountId: op.accountId,
    kind: op.kind,
    payload: op.payload,
  });
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

/**
 * The single gate for all mutations. Enforces the two-step contract:
 * validate() dry-runs the operation and issues a pending-operation id;
 * apply() only executes an operation whose id, hash, and expiry check out.
 */
export class PolicyEngine {
  constructor(
    readonly policy: Policy,
    private readonly pending: PendingRepository = new PendingStore(),
    private readonly audit: AuditRepository = new AuditLog(),
  ) {}

  guard(): WriteGuard {
    return { forcePausedCreation: this.policy.paused_creation };
  }

  async validate(provider: AdProvider, op: WriteOperation): Promise<ValidationOutcome> {
    await this.pending.sweep(); // opportunistic cleanup of expired entries
    await this.checkStaticPolicy(op);
    const preview = await provider.previewWrite(op, this.guard());
    await this.checkBudgetPolicy(op, preview);

    const id = randomUUID();
    const now = Date.now();
    const expiresAt = new Date(now + this.policy.pending_ttl_minutes * 60_000).toISOString();
    await this.pending.put({
      id,
      provider: provider.id,
      opHash: hashOperation(op),
      op,
      preview,
      createdAt: new Date(now).toISOString(),
      expiresAt,
    });
    await this.audit.append({
      event: 'validated',
      provider: provider.id,
      tool: op.tool,
      accountId: op.accountId,
      pendingId: id,
      summary: preview.summary,
    });
    return { pendingOperationId: id, preview, expiresAt };
  }

  async apply(provider: AdProvider, op: WriteOperation, pendingId: string): Promise<ApplyOutcome> {
    // No sweep here: an expired entry must still be readable so the caller
    // gets PENDING_EXPIRED (actionable) instead of PENDING_NOT_FOUND.
    const pending = await this.pending.get(pendingId);
    if (!pending) {
      throw new AdportError(
        'PENDING_NOT_FOUND',
        `No pending operation "${pendingId}". Validate first: call the tool without pending_operation_id.`,
      );
    }
    if (Date.parse(pending.expiresAt) < Date.now()) {
      await this.pending.delete(pendingId);
      throw new AdportError(
        'PENDING_EXPIRED',
        `Pending operation ${pendingId} expired at ${pending.expiresAt}. Validate again.`,
      );
    }
    if (pending.provider !== provider.id || pending.opHash !== hashOperation(op)) {
      throw new AdportError(
        'PENDING_MISMATCH',
        'The operation differs from what was validated. Re-validate with the exact arguments you intend to apply.',
      );
    }
    // Policy may have changed between validate and apply; re-check.
    await this.checkStaticPolicy(op);

    const result = await provider.applyWrite(op, this.guard());
    await this.audit.append({
      event: 'applied',
      provider: provider.id,
      tool: op.tool,
      accountId: op.accountId,
      pendingId,
      summary: pending.preview.summary,
      details: { resourceIds: result.resourceIds },
    });
    await this.pending.delete(pendingId);
    return { result, preview: pending.preview };
  }

  private async checkStaticPolicy(op: WriteOperation): Promise<void> {
    if (this.policy.protected_accounts.includes(op.accountId)) {
      await this.reject(op, `Account ${op.accountId} is protected by policy`);
    }
  }

  private async checkBudgetPolicy(op: WriteOperation, preview: WritePreview): Promise<void> {
    const pctCap = this.policy.max_budget_delta_pct;
    const absCap = this.policy.max_daily_budget_micros;
    for (const delta of preview.budgetDeltas) {
      if (absCap !== null && delta.toMicros > absCap) {
        await this.reject(
          op,
          `${delta.target}: ${delta.toMicros} micros exceeds the absolute budget cap (${absCap})`,
        );
      }
      if (pctCap !== null && delta.fromMicros !== undefined && delta.fromMicros > 0) {
        const pct = (Math.abs(delta.toMicros - delta.fromMicros) / delta.fromMicros) * 100;
        if (pct > pctCap) {
          await this.reject(
            op,
            `${delta.target}: ${pct.toFixed(1)}% change exceeds the ${pctCap}% budget-delta cap`,
          );
        }
      }
    }
  }

  private async reject(op: WriteOperation, reason: string): Promise<never> {
    await this.audit.append({
      event: 'rejected',
      provider: op.provider,
      tool: op.tool,
      accountId: op.accountId,
      summary: reason,
    });
    throw new AdportError('POLICY_VIOLATION', `Policy violation: ${reason}`, { policy: this.policy });
  }
}
