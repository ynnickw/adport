import { createHash } from 'node:crypto';
import { AdportError, defineTool, guardedWriteTool, type AnyToolDefinition, type ReviewField, type WriteOperation, type WritePreview, type WriteResult } from '@adport/core';
import { z } from 'zod';
import type { LinkedInAdsClient } from './client.js';
import type { LinkedInAdsProvider } from './provider.js';
import { accountUrn, linkedinId as id } from './schemas.js';
import { linkedinPageState } from './paging.js';

type Plan = Omit<WritePreview, 'serverValidated'> & { execute(): Promise<WriteResult> };
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const formId = id.max(19).refine(value => BigInt(value) <= 9223372036854775807n, 'Use an exact signed Long form ID');
const nativeId = z.union([formId, z.number().int().positive().safe()]).transform(String);
const locale = z.object({ country: z.string().regex(/^[A-Z]{2}$/), language: z.string().regex(/^[a-z]{2}$/), variant: z.string().regex(/^[A-Za-z0-9]+$/).max(32).optional() }).strict();
const text = z.object({ localized: z.record(z.string().regex(/^[a-z]{2}(?:_[A-Z]{2})?(?:_[A-Za-z0-9]+)?$/), z.string().min(1).max(8192)).refine(value => Object.keys(value).length > 0 && Object.keys(value).length <= 100) }).strict();
const url = z.string().url().max(4096).refine(value => { const parsed = new URL(value); return ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password; }, 'Use an HTTP(S) URL without credentials');
const optionId = z.number().int().nonnegative().max(2147483647);
const option = z.object({ id: optionId, text, label: z.string().min(1).max(200).optional() }).strict();
const choice = z.object({ options: z.array(option).min(1).max(100), defaultSelectedOption: optionId.optional() }).strict().refine(value => new Set(value.options.map(item => item.id)).size === value.options.length && (value.defaultSelectedOption === undefined || value.options.some(item => item.id === value.defaultSelectedOption)), 'Use unique option IDs and an existing default option');
const predefined = z.enum(['FIRST_NAME', 'LAST_NAME', 'PHONE_NUMBER', 'EMAIL', 'CITY', 'STATE', 'COUNTRY', 'ZIP_CODE', 'JOB_TITLE', 'JOB_FUNCTION', 'SENIORITY', 'COMPANY_NAME', 'COMPANY_SIZE', 'INDUSTRY', 'DEGREE', 'FIELD_OF_STUDY', 'SCHOOL', 'START_DATE', 'GRADUATION_DATE', 'GENDER', 'WORK_EMAIL', 'LINKEDIN_PROFILE_LINK', 'WORK_PHONE_NUMBER']);
const question = z.object({ name: z.string().min(1).max(200), question: text, textPrompt: text.optional(), predefinedField: predefined.optional(), responseEditable: z.boolean().optional(), responseRequired: z.boolean().optional(), questionDetails: z.union([
  z.object({ textQuestionDetails: z.object({ defaultResponse: z.string().max(8192).optional(), maxResponseLength: z.number().int().positive().max(100000).optional() }).strict() }).strict(),
  z.object({ multipleChoiceQuestionDetails: choice }).strict(),
]), questionSubmissionCriteria: z.object({ workEmailSubmissionCriteria: z.object({ freemiumEmailAllowed: z.boolean() }).strict() }).strict().optional(), label: z.string().min(1).max(200).optional() }).strict().refine(value => !value.questionSubmissionCriteria || value.predefinedField === 'WORK_EMAIL', 'Work email criteria require WORK_EMAIL');
const questions = z.array(question).min(1).max(100).refine(value => new Set(value.map(item => item.name)).size === value.length && new Set(value.flatMap(item => item.label ? [item.label] : [])).size === value.filter(item => item.label).length, 'Question names and labels must be unique');
const consent = z.object({ id: optionId, consent: text, checkRequired: z.boolean(), label: z.string().min(1).max(200).optional() }).strict();
const legal = z.object({ privacyPolicyUrl: url.optional(), legalDisclaimer: text.refine(value => Object.values(value.localized).every(item => item.length <= 2000)).optional(), consents: z.array(consent).max(100).refine(value => new Set(value.map(item => item.id)).size === value.length, 'Consent IDs must be unique').optional() }).strict();
const cta = z.object({ callToActionLabel: z.enum(['VISIT_COMPANY_WEBSITE', 'LEARN_MORE', 'VIEW_NOW', 'DOWNLOAD_NOW', 'TRY_NOW']), callToActionTarget: z.object({ landingPageUrl: url }).strict().optional() }).strict();
const submission = z.object({ message: text, callToAction: cta }).strict();
const content = z.object({ headline: text, description: text.optional(), questions, legalInfo: legal, postSubmissionInfo: submission.optional() }).strict();
const editContent = content.partial().extend({ postSubmissionInfo: submission.partial().optional() });
const hidden = z.array(z.object({ name: z.string().min(1).max(200), value: z.string().max(8192) }).strict()).max(20).refine(value => new Set(value.map(item => item.name)).size === value.length, 'Hidden-field names must be unique');
const createInput = z.object({ expected_account_hash: hash, name: z.string().trim().min(1).max(200), creation_locale: locale, content, hidden_fields: hidden.default([]) }).strict();
const clear = z.enum(['description', 'legal_disclaimer', 'post_submission_info']);
const updateInput = z.object({ form_id: formId, expected_snapshot_hash: hash, name: z.string().trim().min(1).max(200).optional(), creation_locale: locale.optional(), content: editContent.optional(), hidden_fields: hidden.optional(), clear_fields: z.array(clear).max(3).default([]) }).strict();
const archiveInput = z.object({ form_id: formId, expected_snapshot_hash: hash }).strict();
const pageInput = z.object({ account_id: id, start: z.number().int().nonnegative().safe().default(0), count: z.number().int().min(1).max(100).default(25) }).strict();
const owner = z.union([z.object({ sponsoredAccount: accountUrn }).strict(), z.object({ organization: z.string().regex(/^urn:li:organization:[1-9]\d*$/) }).strict()]);
const native = z.looseObject({ id: nativeId, owner, creationLocale: locale, name: z.string(), state: z.string(), content: z.record(z.string(), z.unknown()), hiddenFields: z.array(z.record(z.string(), z.unknown())).optional(), versionId: z.number().int().nonnegative().safe().optional(), versionTag: z.string().optional(), created: z.number().int().nonnegative().safe().optional(), lastModified: z.number().int().nonnegative().safe().optional() });
const publicForm = native.extend({ id: formId, snapshot_hash: hash });
const contextOutput = { account_id: id, currency: z.string(), account_snapshot_hash: hash };
const paging = z.looseObject({ start: z.number().int().nonnegative().safe(), count: z.number().int().nonnegative().safe(), total: z.number().int().safe().optional(), links: z.array(z.looseObject({ rel: z.string(), href: z.string().optional() })).optional() });
const records = z.array(z.record(z.string(), z.unknown()));
const writes = new Set(['linkedin_create_lead_form_draft', 'linkedin_update_lead_form', 'linkedin_archive_lead_form']);
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : object(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const same = (a: unknown, b: unknown) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const account = (value: string) => `urn:li:sponsoredAccount:${id.parse(value)}`;
const snapshot = (value: z.infer<typeof native>) => digest(Object.fromEntries(Object.entries(value).filter(([key]) => !['created', 'lastModified'].includes(key))));
const notes = ['Form configuration only. No submitted leads are read, no lead is generated and no ad is created or activated.', 'Native writes are not automatically retried. Reconcile returned resource IDs after an uncertain result.'];
const structural = new Set(['content', 'legalInfo', 'postSubmissionInfo']);
const labels: Record<string, string> = { name: 'Name', creationLocale: 'Preferred locale', hiddenFields: 'Hidden fields', headline: 'Headline', description: 'Description', questions: 'Questions', privacyPolicyUrl: 'Privacy policy URL', legalDisclaimer: 'Legal disclaimer', consents: 'Consents', message: 'Thank-you message', callToAction: 'Thank-you action' };
const clearPaths = { description: ['content', 'description'], legal_disclaimer: ['content', 'legalInfo', 'legalDisclaimer'], post_submission_info: ['content', 'postSubmissionInfo'] };
function at(value: unknown, path: string[]): unknown { for (const key of path) value = object(value) ? value[key] : undefined; return value; }
function requestedMatch(actual: unknown, expected: unknown, key = ''): boolean {
  if (key === 'localized') return same(actual, expected);
  if (Array.isArray(expected)) return Array.isArray(actual) && actual.length === expected.length && expected.every((item, index) => requestedMatch(actual[index], item));
  if (object(expected)) return object(actual) && Object.entries(expected).every(([key, item]) => requestedMatch(actual[key], item, key));
  return same(actual, expected);
}
function fieldsOf(current: unknown, requested: Record<string, unknown>): ReviewField[] {
  return Object.entries(requested).flatMap(([key, after]) => structural.has(key) && object(after) ? fieldsOf(object(current) ? current[key] : undefined, after) : [{ label: labels[key] ?? key, ...(object(current) && Object.hasOwn(current, key) ? { before: current[key] } : {}), after }]);
}
// leadForms accepts top-level sets; generated child IDs are read-only. Keep
// those IDs in the expected readback, but never submit them as editable fields.
function wireContent(value: unknown): unknown {
  if (!object(value)) return value;
  const omit = (row: Record<string, unknown>, key: string) => Object.fromEntries(Object.entries(row).filter(([field]) => field !== key));
  return { ...value,
    ...(Array.isArray(value.questions) ? { questions: value.questions.map(item => object(item) ? omit(item, 'questionId') : item) } : {}),
    ...(object(value.legalInfo) ? { legalInfo: omit(value.legalInfo, 'legalInfoId') } : {}),
  };
}
function validateLocale(value: unknown, preferred: string): void {
  if (Array.isArray(value)) { for (const item of value) validateLocale(item, preferred); return; }
  if (!object(value)) return;
  if (object(value.localized) && typeof value.localized[preferred] !== 'string') throw new AdportError('INVALID_INPUT', 'linkedin: every localized form string must contain the preferred creation locale');
  for (const [key, item] of Object.entries(value)) if (key !== 'localized') validateLocale(item, preferred);
}
function merge(current: Record<string, unknown>, requested: Record<string, unknown>): Record<string, unknown> {
  return { ...current, ...Object.fromEntries(Object.entries(requested).map(([key, item]) => [key, structural.has(key) && object(item) && object(current[key]) ? merge(current[key], item) : item])) };
}

/** Official Marketing202608 leadForms/lead-sync-schema contracts checked2026-11-05. */
export class LinkedInLeadFormService {
  constructor(private readonly client: LinkedInAdsClient, private readonly provider: LinkedInAdsProvider) {}
  supports(tool: string) { return writes.has(tool); }
  private async context(selected: string) { const value = await this.provider.getAccount(id.parse(selected)); return { account_id: selected, currency: value.currency, account_snapshot_hash: digest({ id: value.id, currency: value.currency, status: value.status }) }; }
  private owned(selected: string, value: z.infer<typeof native>, selectedForm?: string) {
    if (!('sponsoredAccount' in value.owner) || value.owner.sponsoredAccount !== account(selected) || selectedForm !== undefined && value.id !== selectedForm) throw new AdportError('PROVIDER_ERROR', 'linkedin: lead form owner or ID does not match the selected advertiser');
    return { ...value, snapshot_hash: snapshot(value) };
  }
  private async one(selected: string, form: string) { return this.owned(selected, await this.client.get(`leadForms/${formId.parse(form)}`, native), form); }
  private record(value: z.infer<typeof native>) {
    const preferred = [value.creationLocale.language, value.creationLocale.country, value.creationLocale.variant].filter(Boolean).join('_');
    const headline = object(value.content.headline) && object(value.content.headline.localized) ? value.content.headline.localized[preferred] : undefined;
    return { id: value.id, name: value.name, status: value.state, locale: preferred, ...(typeof headline === 'string' ? { headline } : {}), ...(Array.isArray(value.content.questions) ? { questions: value.content.questions.length } : {}), ...(value.versionId !== undefined ? { version: value.versionId } : {}) };
  }
  async list(raw: z.input<typeof pageInput>) {
    const input = pageInput.parse(raw), context = await this.context(input.account_id);
    const page = await this.client.get('leadForms', z.looseObject({ elements: z.array(native), paging: paging.optional() }), { q: 'owner', owner: { sponsoredAccount: account(input.account_id) }, start: input.start, count: input.count });
    const elements = page.elements.map(value => this.owned(input.account_id, value));
    if (new Set(elements.map(value => value.id)).size !== elements.length) throw new AdportError('PROVIDER_ERROR', 'linkedin: repeated lead form identity');
    const state = linkedinPageState(page, input.start, input.count, 'leadForms');
    return { ...context, ...page, elements, records: elements.map(value => this.record(value)), ...state, notes: [...notes, ...(state.notes ?? [])] };
  }
  async get(selected: string, form: string) { const context = await this.context(selected), value = await this.one(selected, form); return { ...context, form: value, records: [this.record(value)], notes }; }
  private async verified(resource: string, check: () => Promise<boolean>) {
    try { if (!await check()) throw new Error('configuration mismatch'); }
    catch { throw new AdportError('PROVIDER_ERROR', 'linkedin: lead form write readback unconfirmed; reconcile returned resource ID before another approval', { resource_ids: [resource] }); }
  }
  async plan(op: WriteOperation): Promise<Plan> {
    const create = op.tool === 'linkedin_create_lead_form_draft';
    if (op.provider !== 'linkedin' || !writes.has(op.tool) || op.kind !== (create ? 'create' : 'update')) throw new AdportError('INVALID_INPUT', 'linkedin: lead form operation kind mismatch');
    const context = await this.context(op.accountId), base = { coercions: [], budgetDeltas: [], notes };
    if (create) {
      const input = createInput.parse(op.payload);
      if (input.expected_account_hash !== context.account_snapshot_hash) throw new AdportError('INVALID_INPUT', 'linkedin: advertiser snapshot changed; read its lead forms again');
      const body = { owner: { sponsoredAccount: account(op.accountId) }, name: input.name, creationLocale: input.creation_locale, content: input.content, hiddenFields: input.hidden_fields, state: 'DRAFT' };
      if (Buffer.byteLength(JSON.stringify(body)) > 256 * 1024) throw new AdportError('INVALID_INPUT', 'linkedin: form configuration exceeds 256 KiB');
      validateLocale(body.content, [input.creation_locale.language, input.creation_locale.country, input.creation_locale.variant].filter(Boolean).join('_'));
      return { ...base, summary: `Create LinkedIn lead form draft "${input.name}"`, changes: [`+ ${JSON.stringify(body)}`], review: { provider: 'linkedin', accountId: op.accountId, kind: 'create', title: 'Create lead form draft', subject: input.name, fields: [{ label: 'State', after: 'DRAFT' }, ...fieldsOf(undefined, { creationLocale: body.creationLocale, content: body.content, hiddenFields: body.hiddenFields })], notices: ['Draft only. No creative is linked and no form is published. Omitted question/CTA settings use native defaults reported by readback.'] }, execute: async () => {
        const resource = await this.client.create('leadForms', body);
        await this.verified(resource, async () => requestedMatch(await this.one(op.accountId, resource), body));
        return { applied: true, resourceIds: [resource] };
      } };
    }
    const input = op.tool === 'linkedin_archive_lead_form' ? archiveInput.parse(op.payload) : updateInput.parse(op.payload), current = await this.one(op.accountId, input.form_id);
    if (current.snapshot_hash !== input.expected_snapshot_hash) throw new AdportError('INVALID_INPUT', 'linkedin: lead form snapshot changed; read the current form');
    if (op.tool === 'linkedin_archive_lead_form') {
      if (current.state !== 'PUBLISHED') throw new AdportError('INVALID_INPUT', 'linkedin: the documented archive transition requires a PUBLISHED form');
      return { ...base, summary: `Archive LinkedIn lead form "${current.name}"`, changes: ['~ state PUBLISHED → ARCHIVED'], review: { provider: 'linkedin', accountId: op.accountId, kind: 'update', title: 'Archive lead form', subject: current.name, fields: [{ label: 'State', before: current.state, after: 'ARCHIVED' }], notices: ['Archiving changes whether this form and its linked creatives can serve. No restore transition is exposed by this tool.'] }, execute: async () => {
        await this.client.partialUpdate(`leadForms/${current.id}`, { $set: { state: 'ARCHIVED' } });
        await this.verified(current.id, async () => (await this.one(op.accountId, current.id)).state === 'ARCHIVED');
        return { applied: true, resourceIds: [current.id] };
      } };
    }
    const update = updateInput.parse(op.payload);
    if (!['DRAFT', 'PUBLISHED'].includes(current.state)) throw new AdportError('INVALID_INPUT', 'linkedin: this form state cannot be edited');
    if (update.content?.postSubmissionInfo && !object(current.content.postSubmissionInfo) && !submission.safeParse(update.content.postSubmissionInfo).success) throw new AdportError('INVALID_INPUT', 'linkedin: adding thank-you information requires both message and callToAction');
    const requested: Record<string, unknown> = { ...(update.name !== undefined ? { name: update.name } : {}), ...(update.creation_locale ? { creationLocale: update.creation_locale } : {}), ...(update.content ? { content: update.content } : {}), ...(update.hidden_fields ? { hiddenFields: update.hidden_fields } : {}) };
    if (Buffer.byteLength(JSON.stringify(requested)) > 256 * 1024) throw new AdportError('INVALID_INPUT', 'linkedin: form configuration exceeds 256 KiB');
    if (current.state === 'PUBLISHED' && (update.name !== undefined || update.creation_locale || update.hidden_fields || update.content?.questions || update.content?.legalInfo?.consents)) throw new AdportError('INVALID_INPUT', 'linkedin: schema/name/locale/hidden-field edits require DRAFT; published forms allow copy, legal URL/disclaimer and thank-you edits subject to native eligibility');
    const removed: string[][] = [], review = fieldsOf(current, requested);
    for (const field of new Set(update.clear_fields)) {
      const path = clearPaths[field];
      if (at(requested, path) !== undefined || at(current, path) === undefined) throw new AdportError('INVALID_INPUT', 'linkedin: a cleared field must exist and cannot also be supplied');
      removed.push(path);
      review.push({ label: labels[path.at(-1)!] ?? field, before: at(current, path), after: null });
    }
    const wanted = merge(current, requested), preferred = update.creation_locale ?? current.creationLocale;
    for (const path of removed) { let target = wanted; for (const key of path.slice(0, -1)) { target[key] = { ...(target[key] as Record<string, unknown>) }; target = target[key] as Record<string, unknown>; } delete target[path.at(-1)!]; }
    validateLocale(wanted.content, [preferred.language, preferred.country, preferred.variant].filter(Boolean).join('_'));
    if (requestedMatch(current, requested) && !removed.length) throw new AdportError('INVALID_INPUT', 'linkedin: no supplied form settings would change');
    const set = Object.fromEntries(Object.keys(requested).map(key => [key, wanted[key]]));
    if (update.content || removed.length) set.content = wanted.content;
    const patch = { $set: { ...set, ...(set.content ? { content: wireContent(set.content) } : {}) } };
    if (Buffer.byteLength(JSON.stringify(patch)) > 256 * 1024) throw new AdportError('INVALID_INPUT', 'linkedin: merged form configuration exceeds 256 KiB');
    return { ...base, summary: `Update LinkedIn lead form "${current.name}"`, changes: [`~ ${JSON.stringify(patch)}`], review: { provider: 'linkedin', accountId: op.accountId, kind: 'update', title: 'Update lead form', subject: current.name, fields: review, notices: ['Supplied localized maps and question/consent/hidden-field arrays replace their previous values. Other settings remain unchanged.', 'Question/schema edits can require CRM field remapping. LinkedIn determines published edit eligibility; forms linked to InMail or Conversation Ads may reject edits.'] }, execute: async () => {
      await this.client.partialUpdate(`leadForms/${current.id}`, patch);
      await this.verified(current.id, async () => { const value = await this.one(op.accountId, current.id); return value.state === current.state && requestedMatch(value, set) && removed.every(path => at(value, path) === undefined); });
      return { applied: true, resourceIds: [current.id] };
    } };
  }
}

export function linkedinLeadFormTools(provider: LinkedInAdsProvider): AnyToolDefinition[] {
  return [
    defineTool({ name: 'linkedin_lead_forms', namespace: 'linkedin', description: 'List advertiser-owned lead form configuration with exact string IDs, paging and snapshot hashes. No submitted leads or extra scopes.', input: pageInput, output: z.looseObject({ ...contextOutput, elements: z.array(publicForm), records, paging: paging.optional(), complete: z.boolean().nullable(), truncated: z.boolean(), next_start: z.number().int().nonnegative().safe().optional(), notes: z.array(z.string()) }), presentation: 'records', pagination: { cursorInput: 'start', cursorOutput: 'next_start' }, annotations: { readOnly: true }, handler: input => provider.leadForms.list(input) }),
    defineTool({ name: 'linkedin_get_lead_form', namespace: 'linkedin', description: 'Read one advertiser-owned lead form and its snapshot_hash. IDs must be exact decimal strings; form configuration excludes submitted lead data.', input: z.object({ account_id: id, form_id: formId }).strict(), output: z.object({ ...contextOutput, form: publicForm, records, notes: z.array(z.string()) }), presentation: 'records', annotations: { readOnly: true }, handler: input => provider.leadForms.get(input.account_id, input.form_id) }),
    guardedWriteTool({ name: 'linkedin_create_lead_form_draft', namespace: 'linkedin', provider: 'linkedin', kind: 'create', destructive: false, payload: createInput, description: 'Create an advertiser-owned DRAFT with localized questions, legal/thank-you content and hidden fields. Bind expected_account_hash from linkedin_lead_forms. No publication, creative linking, lead collection or scope changes.' }),
    guardedWriteTool({ name: 'linkedin_update_lead_form', namespace: 'linkedin', provider: 'linkedin', kind: 'update', payload: updateInput, description: 'Edit an owned form with expected_snapshot_hash. Full schema edits require DRAFT; published copy/legal/thank-you edits remain subject to native eligibility. Supplied arrays and localized maps replace; omitted settings stay. CRM remapping may be required.' }),
    guardedWriteTool({ name: 'linkedin_archive_lead_form', namespace: 'linkedin', provider: 'linkedin', kind: 'update', payload: archiveInput, description: 'Archive a PUBLISHED owned form with expected_snapshot_hash. This can stop its linked creatives serving; no restore transition is exposed. No deletion or scope changes.' }),
  ];
}
