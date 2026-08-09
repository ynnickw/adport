import { resolveDateRange, type DatePreset, type DateRange, type ReportRow } from '../model.js';
import { selectConnectedProviders, type ProviderRegistry } from '../provider.js';
import { corePerformancePack } from './packs/core-performance.js';
import { FindingsStore } from './store.js';
import type { AuditFinding, RulePack } from './types.js';

export interface AuditRunOptions {
  provider?: string;
  accountIds?: string[];
  dateRange?: DateRange | DatePreset;
  packs?: RulePack[];
  configOverrides?: Record<string, number>;
}

export interface AuditRunResult {
  findings: AuditFinding[];
  counts: { critical: number; warn: number; info: number };
  evaluatedAccounts: number;
  range: DateRange;
}

/**
 * The audit engine (OPA pattern): providers supply normalized state as input,
 * rule packs supply the checks, the runner evaluates and returns structured
 * findings. Rules never call provider APIs directly.
 */
export class AuditRunner {
  constructor(
    private readonly providers: ProviderRegistry,
    private readonly store: FindingsStore = new FindingsStore(),
  ) {}

  async run(options: AuditRunOptions = {}): Promise<AuditRunResult> {
    const range = resolveDateRange(options.dateRange ?? 'last_30_days');
    const packs = options.packs ?? [corePerformancePack];
    const providers = selectConnectedProviders(this.providers, options.provider);

    const findings: AuditFinding[] = [];
    let evaluatedAccounts = 0;

    for (const provider of providers) {
      const report = await provider.report({
        accountIds: options.accountIds,
        level: 'campaign',
        metrics: ['spend', 'impressions', 'clicks', 'conversions', 'conversion_value', 'ctr', 'cpc', 'cpa', 'roas'],
        dateRange: range,
        limit: 1000,
      });
      const byAccount = new Map<string, ReportRow[]>();
      for (const row of report.rows) {
        const rows = byAccount.get(row.accountId) ?? [];
        rows.push(row);
        byAccount.set(row.accountId, rows);
      }
      const actions = provider.standardActions?.() ?? {};

      for (const [accountId, rows] of byAccount) {
        evaluatedAccounts += 1;
        for (const pack of packs) {
          const config = { ...pack.defaults, ...options.configOverrides };
          for (const rule of pack.rules) {
            for (const ruleFinding of rule.evaluate({ provider: provider.id, accountId, rows, range, actions, config })) {
              const id = `${rule.id}:${provider.id}:${accountId}:${ruleFinding.entity.id}`;
              const existing = await this.store.get(id);
              // Respect earlier human decisions: don't reopen dismissed/applied findings.
              if (existing && existing.status !== 'open') continue;
              const now = new Date().toISOString();
              const finding: AuditFinding = {
                id,
                ruleId: rule.id,
                severity: ruleFinding.severity,
                provider: provider.id,
                accountId,
                entity: ruleFinding.entity,
                title: ruleFinding.title,
                detail: ruleFinding.detail,
                recommendation: ruleFinding.recommendation,
                proposedAction: ruleFinding.proposedAction,
                metrics: ruleFinding.metrics,
                dateRange: range,
                status: 'open',
                createdAt: existing?.createdAt ?? now,
                updatedAt: now,
              };
              await this.store.save(finding);
              findings.push(finding);
            }
          }
        }
      }
    }

    return {
      findings,
      counts: {
        critical: findings.filter((f) => f.severity === 'critical').length,
        warn: findings.filter((f) => f.severity === 'warn').length,
        info: findings.filter((f) => f.severity === 'info').length,
      },
      evaluatedAccounts,
      range,
    };
  }
}
