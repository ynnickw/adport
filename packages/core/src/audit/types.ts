import type { DateRange, MetricName, ReportRow } from '../model.js';
import type { StandardAction, StandardActions } from '../provider.js';

export type FindingSeverity = 'info' | 'warn' | 'critical';
export type FindingStatus = 'open' | 'dismissed' | 'applied';

/**
 * A single audit finding. Deliberately NOT aggregated into any kind of
 * "account score": interaction-based scores are gameable and distrusted
 * (Google's optimization score reaches 100% by dismissing everything).
 */
export interface AuditFinding {
  /** Deterministic: ruleId:provider:accountId:entityId — reruns update, not duplicate. */
  id: string;
  ruleId: string;
  severity: FindingSeverity;
  provider: string;
  accountId: string;
  entity: { level: string; id: string; name: string; status?: string };
  title: string;
  detail: string;
  recommendation: string;
  /** Ready-to-run tool call; flows through the normal validate→apply gate. */
  proposedAction?: StandardAction;
  metrics: Partial<Record<MetricName, number>>;
  dateRange: DateRange;
  status: FindingStatus;
  createdAt: string;
  updatedAt: string;
}

/** What a rule emits; the runner adds ids, timestamps, and status. */
export interface RuleFinding {
  entity: AuditFinding['entity'];
  severity: FindingSeverity;
  title: string;
  detail: string;
  recommendation: string;
  proposedAction?: StandardAction;
  metrics: AuditFinding['metrics'];
}

export interface RuleContext {
  provider: string;
  accountId: string;
  /** Campaign-level normalized rows for this account over the range. */
  rows: ReportRow[];
  range: DateRange;
  /** Provider-declared action mappings (may be empty). */
  actions: StandardActions;
  /** Pack-level thresholds, overridable per run. */
  config: Record<string, number>;
}

export interface Rule {
  id: string;
  title: string;
  description: string;
  evaluate(ctx: RuleContext): RuleFinding[];
}

/** OPA-style pack: rules are data-driven and decoupled from provider code. */
export interface RulePack {
  name: string;
  version: string;
  rules: Rule[];
  /** Default thresholds; merged with per-run overrides. */
  defaults: Record<string, number>;
}
