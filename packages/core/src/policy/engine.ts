import { createHash, randomUUID } from 'node:crypto';
import { AdportError } from '../errors.js';
import type { AdProvider, WriteGuard, WriteOperation, WritePreview, WriteResult } from '../provider.js';
import { AuditLog, type AuditEntryStore } from './audit.js';
import { PendingStore, type PendingOperationStore } from './pending.js';
import type { Policy } from './policy.js';
import { canonicalAccountId } from '../account-id.js';
import { failureAuditDetails } from './failure.js';

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

export function hashOperation(op: WriteOperation, policy?: Policy): string {
  const canonical = canonicalize({
    approval_protocol: 'single_attempt_v1',
    tool: op.tool,
    provider: op.provider,
    accountId: op.accountId,
    kind: op.kind,
    payload: op.payload,
    ...(policy ? { policy: { ...policy, protected_accounts: [...new Set(policy.protected_accounts)].sort() } } : {}),
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
    private readonly pending: PendingOperationStore = new PendingStore(),
    private readonly audit: AuditEntryStore = new AuditLog(),
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
      // Bind the effective policy too: changing limits or coercions requires a new preview.
      opHash: hashOperation(op, this.policy),
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
        'No unused approval was found. It may have expired or already been attempted. Check provider state and the audit log before requesting a new preview.',
      );
    }
    if (Date.parse(pending.expiresAt) < Date.now()) {
      await this.pending.delete(pendingId);
      throw new AdportError(
        'PENDING_EXPIRED',
        `Pending operation ${pendingId} expired at ${pending.expiresAt}. Validate again.`,
      );
    }
    if (pending.provider !== provider.id || pending.opHash !== hashOperation(op, this.policy)) {
      throw new AdportError(
        'PENDING_MISMATCH',
        'The operation or safety policy differs from this preview. Call the tool without pending_operation_id to preview again before applying.',
      );
    }
    // Policy may have changed between validate and apply; re-check.
    await this.checkStaticPolicy(op);

    // Provider state can change while an approval is pending. Re-read current
    // monetary values so relative caps also hold at apply, and do not silently
    // approve a new amount resolved from a recommendation or shared resource.
    const preview = await provider.previewWrite(op, this.guard());
    await this.checkBudgetPolicy(op, preview);
    const targets = (value: WritePreview) => JSON.stringify(canonicalize(value.budgetDeltas.map(({ target, toMicros, currency }) => ({ target, toMicros, ...(currency ? { currency } : {}) }))));
    if (targets(preview) !== targets(pending.preview)) {
      await this.audit.append({ event: 'rejected', provider: provider.id, tool: op.tool, accountId: op.accountId, pendingId, summary: 'The proposed monetary targets changed after preview' });
      throw new AdportError('PENDING_MISMATCH', 'The proposed monetary targets changed after preview. Request and approve a fresh preview before applying.');
    }

    if (!await this.pending.consume(pendingId, pending.opHash)) throw new AdportError('PENDING_NOT_FOUND', 'This approval is no longer available, expired, or was claimed by another apply. Check provider state and the audit log before requesting a new preview.');
    const identity = { provider: provider.id, tool: op.tool, accountId: op.accountId, pendingId };
    try {
      await this.audit.append({ ...identity, event: 'note', summary: 'Approval consumed; provider apply is starting. This is not proof of a completed change.', details: { phase: 'apply_started', outcome: 'UNCONFIRMED' } });
    } catch {
      throw new AdportError('PROVIDER_ERROR', 'The approval was consumed, but its start audit could not be recorded. The provider apply was not called. Request a fresh preview after resolving the audit failure.', { approval_consumed: true, apply_state: 'NOT_STARTED' });
    }
    let result: WriteResult, attempted = false;
    try {
      if (!(Date.parse(pending.expiresAt) > Date.now())) throw new AdportError('PENDING_EXPIRED', 'The approval expired before provider execution. The provider apply was not called.');
      attempted = true;
      result = await provider.applyWrite(op, this.guard());
    }
    catch (error) {
      let recorded = true;
      try { await this.audit.append({ ...identity, event: 'note', summary: attempted ? 'Provider apply did not confirm completion. Changes may be partial or unknown; reconcile before a new preview. The approval cannot be replayed.' : 'Approval expired before provider execution. The provider apply was not called; the approval cannot be replayed.', details: { ...failureAuditDetails(provider.id, error), ...(!attempted ? { outcome: 'NOT_STARTED' } : {}) } }); }
      catch { recorded = false; }
      const original = error instanceof AdportError ? error : undefined;
      const details = original?.details && typeof original.details === 'object' && !Array.isArray(original.details) ? original.details as Record<string, unknown> : original?.details !== undefined ? { native_details: original.details } : {};
      throw new AdportError(original?.code ?? 'PROVIDER_ERROR', `${original?.message ?? 'Provider apply outcome could not be confirmed.'} The approval was consumed. Reconcile provider state before requesting another preview; do not replay this apply.${recorded ? '' : ' The failure audit could not be recorded.'}`, { ...details, approval_consumed: true, apply_state: attempted ? 'UNCONFIRMED' : 'NOT_STARTED', failure_audit_recorded: recorded });
    }
    try {
      await this.audit.append({ ...identity, event: 'applied', summary: preview.summary, details: { resourceIds: result.resourceIds, ...(result.warnings?.length ? { warnings: result.warnings } : {}) } });
    } catch {
      throw new AdportError('PROVIDER_ERROR', 'The provider reported the change applied, but the completion audit could not be recorded. The approval was consumed. Reconcile these resource IDs; do not repeat the write.', { approval_consumed: true, apply_state: 'APPLIED_AUDIT_UNCONFIRMED', resource_ids: result.resourceIds });
    }
    return { result, preview };
  }

  private async checkStaticPolicy(op: WriteOperation): Promise<void> {
    if (this.policy.protected_accounts.some(id => canonicalAccountId(op.provider, id) === canonicalAccountId(op.provider, op.accountId))) {
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
