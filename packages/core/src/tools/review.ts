import type { WriteOperation, WritePreview } from '../provider.js';

export interface ReviewField {
  label: string;
  before?: unknown;
  after: unknown;
  format?: 'money' | 'text';
  currency?: string;
}

export interface WriteReview {
  provider: string;
  accountId: string;
  kind: WriteOperation['kind'];
  title: string;
  subject?: string;
  fields: ReviewField[];
  notices: string[];
}

const words = (value: string) => value.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_.]/g, ' ').replace(/\s+/g, ' ').trim();
const label = (value: string) => { const text = words(value); return text.charAt(0).toUpperCase() + text.slice(1); };
const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const routing = /^(account_id|pending_operation_id|project_id|campaign_id|ad_group_id|ad_set_id|object_id|advertiser_id|organization_id|service|resource|method|path|endpoint|update_mask)$/i;
const budget = /^(?:(?:daily|total|lifetime|shared)[_ ]?)?(?:budget|budget_amount|amount_micros|dailyBudget\.value)(?:[_ ]?(?:micros|cents|amount|value))?$/i;
const status = /^(?:status|entity_status|configured_status|operation_status|delivery)$/i;
const secret = /(?:access_token|refresh_token|authorization|password|client_secret|private_key)/i;

function reviewValue(value: unknown, adjustedStatus: boolean, key = ''): unknown {
  if (typeof value === 'string' && (/^data:/.test(value) || /base64|file_content|image_data/i.test(key))) return `Attached content (${value.length} characters)`;
  if (Array.isArray(value)) return value.map(item => reviewValue(item, adjustedStatus));
  if (isObject(value)) return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !secret.test(key) && !(adjustedStatus && status.test(key)))
    .map(([key, item]) => [key, reviewValue(item, adjustedStatus, key)]));
  return value;
}

function flatten(value: Record<string, unknown>, prefix = ''): ReviewField[] {
  return Object.entries(value).flatMap(([key, item]): ReviewField[] => {
    if (item === undefined || secret.test(key)) return [];
    const path = prefix ? `${prefix}.${key}` : key;
    if (isObject(item)) return flatten(item, /^(fields|body|payload|update|create)$/.test(key) ? prefix : path);
    return [{ label: label(path), after: item, ...(/(?:text|headline|description|message)$/i.test(key) ? { format: 'text' as const } : {}) }];
  });
}

/** Adapt the legacy plan's explicitly reported observations; never infer a
 * previous value from a request, a summary, or another account's object. */
function observedFields(changes: string[]): ReviewField[] {
  return changes.flatMap(change => {
    const match = change.match(/^~\s+.*?\b(status|configured_status|entity_status|operation_status|bidding_strategy|delivery|name|bid|cpc_bid_ceiling_micros|DailyBudget|dailyBudget\.value|value|startTime|endTime|start_time|end_time)\s*:?\s*(.*?)\s*→\s*(.+)$/i);
    if (!match) return [];
    return [{ label: label(match[1]!), ...(match[2]!.trim() && !/^(?:\?|unknown|unavailable)$/i.test(match[2]!.trim()) ? { before: match[2]!.trim() } : {}), after: match[3]!.trim() }];
  });
}

/** One transport-independent review for every guarded tool, including generic
 * provider writes. Providers can supply richer, observed fields in review. */
export function reviewWrite(op: WriteOperation, preview: WritePreview): WriteReview {
  if (preview.review) return preview.review;
  let title = label(op.tool.replace(new RegExp(`^${op.provider}_`), '').replace(/^api_/, ''));
  if (/_api_/.test(op.tool)) {
    const resource = op.payload.service ?? op.payload.resource ?? op.payload.edge ?? op.payload.path;
    if (typeof resource === 'string') title += ` ${resource}`;
  }
  const target = ['criterion_id', 'ad_id', 'ad_group_id', 'ad_set_id', 'campaign_id', 'object_id']
    .find(key => typeof op.payload[key] === 'string');
  const subject = preview.summary.match(/"([^"]+)"/)?.[1]
    ?? (op.kind === 'create' && typeof op.payload.name === 'string' ? op.payload.name : undefined)
    ?? (target ? `${label(target.replace(/_id$/, ''))} ${op.payload[target]}` : undefined);
  const money: ReviewField[] = preview.budgetDeltas.map(delta => ({
    label: label(delta.target), format: 'money',
    ...(delta.fromMicros === undefined ? {} : { before: delta.fromMicros }), after: delta.toMicros,
    ...(delta.currency ? { currency: delta.currency } : {}),
  }));
  const structured = preview.fieldChanges?.every(field => typeof field.field === 'string' && typeof field.before === 'string' && typeof field.after === 'string')
    ? preview.fieldChanges.map(field => ({ label: field.field, before: field.before, after: field.after })) : undefined;
  const observed = (structured ?? observedFields(preview.changes)).filter(field => !money.length || !budget.test(field.label));
  const adjustedStatus = preview.coercions.some(note => /status|paused|disable|draft/i.test(note));
  const original = flatten(reviewValue(op.payload, adjustedStatus) as Record<string, unknown>).filter(field => {
    const key = field.label.replaceAll(' ', '_');
    if (op.kind !== 'remove' && routing.test(key)) return false;
    if (money.length && budget.test(field.label.replaceAll(' ', '_'))) return false;
    if (observed.some(item => item.label.toLowerCase() === field.label.toLowerCase()
      || (item.label.toLowerCase().endsWith(` ${field.label.toLowerCase()}`) && JSON.stringify(item.after) === JSON.stringify(field.after)))) return false;
    // The provider's coercion is the authoritative final status. Never show
    // a requested ACTIVE beside a plan which will actually create PAUSED.
    if (status.test(key) && preview.coercions.some(note => /status|paused|disable|draft/i.test(note))) return false;
    return field.after !== subject || !/^(?:name|campaign name)$/i.test(field.label);
  });
  const fields = [...money, ...observed, ...original];
  if (!fields.length && op.kind === 'remove') {
    for (const change of preview.changes) if (/^-\s/.test(change)) fields.push({ label: 'Remove', after: change.slice(1).trim() });
  }
  return {
    provider: op.provider, accountId: op.accountId, kind: op.kind, title,
    ...(subject ? { subject } : {}), fields,
    notices: [...(preview.notes ?? []), ...preview.changes.filter(change => /^!\s/.test(change)).map(change => change.replace(/^!\s*/, ''))],
  };
}
