import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AuditLog, createContext, DEFAULT_POLICY, PendingStore, PolicyEngine, type WriteOperation } from '@adport/core';
import { audienceRuleSelection } from '../src/audience-authoring-schemas.js';
import { tiktokTools } from '../src/tools.js';
import { audienceAuthoringFixture, ruleInput } from './audience-authoring-fixture.js';
import { CUSTOM_ACCOUNT, NEW_CUSTOM_AUDIENCE } from './custom-audience-fixture.js';

// Official f809c396 YAML + generated JS models and live v1.3 portal table,
// checked2026-11-06: filters[].parameter_filters[], AND conditions / OR values.
// The prose example is invalid JSON; these tests follow the formal structure.
type Row = Record<string, any>;
const tool = 'tiktok_create_rule_audience', guard = { forcePausedCreation: true }, dirs: string[] = [];
const operation = (payload: Row): WriteOperation => ({ provider: 'tiktok', accountId: CUSTOM_ACCOUNT, kind: 'create', tool, payload });
const event = (input: Row) => input.rule_spec.inclusion_rule_set.rules[0].filter_set.filters[0];
const url = (operator = 'CONTAINS') => ({ field: 'URL', operator, values: ['/checkout + ✓', '/purchase'] });
const filtered = (filters: Row[] = [url()]) => { const input = ruleInput();event(input).parameter_filters = filters;return input; };
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

describe('TikTok nested URL and web-event audience filters', () => {
  it.each(['CONTAINS', 'DOES_NOT_CONTAIN', 'EQ', 'NOT_EQUAL'])('sends documented URL %s inside the action filter without rewriting values', async operator => {
    const f = audienceAuthoringFixture(), input = filtered([url(operator)]), args = await f.createRule(input), preview = await f.provider.previewWrite(operation(args), guard);
    expect(f.writes()).toHaveLength(0);expect(preview.review?.fields).toContainEqual({ label: 'Include any', after: [{ event: 'PIXEL COMPLETE PAYMENT', lookback_days: 30, sources: ['1001'], all_conditions: [{ field: 'URL', operator, any_values: ['/checkout + ✓', '/purchase'] }] }] });
    expect(preview.notes).toContain('Each rule requires its event AND every parameter condition. Values within each condition use OR. Inclusion rules use OR; matching exclusion rules remove users.');
    const result = await f.provider.applyWrite(operation(args), guard), body = f.writes()[0]!.body!;
    expect(body.rule_spec).toEqual(input.rule_spec);expect(body.rule_spec.inclusion_rule_set.rules[0].filter_set).not.toHaveProperty('parameter_filters');expect(body.rule_spec.inclusion_rule_set.rules[0]).not.toHaveProperty('parameter_filters');expect(event(body).parameter_filters).toEqual([url(operator)]);
    expect(result).toMatchObject({ resourceIds: [NEW_CUSTOM_AUDIENCE], details: { rule_readback: 'VERIFIED_NATIVE_ECHO', processed: false, membership_verified: false } });expect(f.writes()).toHaveLength(1);
  });
  const fields = ['CONTENT_TYPE', 'PRICE', 'VALUE', 'CONTENT_ID', 'CONTENT_CATEGORY'];
  it.each(['CONTAINS', 'DOES_NOT_CONTAIN', 'EQ', 'NOT_EQUAL', 'IS_LESS_THAN', 'IS_GREATER_THAN', 'IS_LESS_THAN_OR_EQUAL_TO', 'IS_GREATER_THAN_OR_EQUAL_TO'].map((operator, index) => ({ field: fields[index % fields.length]!, operator })))('preserves native $field / $operator parameter conditions in inclusion and exclusion rules', async ({ field, operator }) => {
    const f = audienceAuthoringFixture(), condition = { field, operator, values: ['25.00', '00100'] }, input = filtered([url(), condition]);input.rule_spec.exclusion_rule_set = structuredClone(input.rule_spec.inclusion_rule_set);event(input).value = 'PIXEL VIEW CONTENT';
    const args = await f.createRule(input), preview = await f.provider.previewWrite(operation(args), guard);expect(preview.review?.fields.some(row => row.label === 'Exclude any')).toBe(true);
    await f.provider.applyWrite(operation(args), guard);expect(f.writes()[0]!.body!.rule_spec).toEqual(input.rule_spec);expect(condition.values).toEqual(['25.00', '00100']);
  });
  it('supports one URL plus ten parameter conditions, each with ten100-character values', () => {
    const conditions = [url(), ...Array.from({ length: 10 }, (_, i) => ({ field: 'CONTENT_ID', operator: 'EQ', values: Array.from({ length: 10 }, (_, j) => `${i}-${j}`.padEnd(100, 'x')) }))];
    expect(audienceRuleSelection.safeParse(filtered(conditions)).success).toBe(true);
  });
  it.each([
    { label: 'two URL conditions', filters: [url(), url('EQ')] },
    { label: 'eleven non-URL conditions', filters: Array.from({ length: 11 }, () => ({ field: 'VALUE', operator: 'EQ', values: ['1'] })) },
    { label: 'twelve conditions', filters: [url(), ...Array.from({ length: 11 }, () => ({ field: 'VALUE', operator: 'EQ', values: ['1'] }))] },
    { label: 'empty conditions', filters: [] },
    { label: 'unknown field', filters: [{ field: 'PRIVATE_CUSTOM_FIELD', operator: 'EQ', values: ['1'] }] },
    { label: 'URL numeric comparison', filters: [url('IS_LESS_THAN')] },
    { label: 'misspelled operator alias', filters: [url('DOES_NOT_CONTAINS')] },
    { label: 'singular value', filters: [{ field: 'URL', operator: 'EQ', value: '/checkout' }] },
    { label: 'empty values', filters: [{ field: 'URL', operator: 'EQ', values: [] }] },
    { label: 'eleven values', filters: [{ field: 'URL', operator: 'EQ', values: Array.from({ length: 11 }, (_, i) => String(i)) }] },
    { label: 'long value', filters: [{ field: 'URL', operator: 'EQ', values: ['x'.repeat(101)] }] },
    { label: 'empty value', filters: [{ field: 'URL', operator: 'EQ', values: [''] }] },
    { label: 'numeric value', filters: [{ field: 'VALUE', operator: 'EQ', values: [25] }] },
    { label: 'control character', filters: [{ field: 'URL', operator: 'EQ', values: ['a\u0000b'] }] },
  ])('rejects $label before source lookup or mutation', async ({ filters }) => {
    const f = audienceAuthoringFixture();await expect(f.context(filtered(filters))).rejects.toThrow();expect(f.calls).toHaveLength(0);
  });
  it.each(['rule', 'filter-set'])('rejects parameter_filters at the undocumented %s level', async level => {
    const f = audienceAuthoringFixture(), input = ruleInput(), rule = input.rule_spec.inclusion_rule_set.rules[0];(level === 'rule' ? rule : rule.filter_set).parameter_filters = [url()];await expect(f.context(input)).rejects.toThrow();expect(f.calls).toHaveLength(0);
  });
  it('compares AND-condition and OR-value echoes without depending on native ordering, retaining submitted order', async () => {
    const f = audienceAuthoringFixture(), input = filtered([url(), { field: 'VALUE', operator: 'IS_GREATER_THAN', values: ['25.00', '100'] }]), args = await f.createRule(input);
    f.sourceState.hook = ({ url: target }) => { if (target.pathname.endsWith('/custom_audience/get/') && f.sourceState.mutated) { const row = f.state.rows.find(row => row.audience_id === NEW_CUSTOM_AUDIENCE)!, rule = JSON.parse(row.rule);event({ rule_spec: rule }).parameter_filters.reverse().forEach((condition: Row) => condition.values.reverse());row.rule = JSON.stringify(rule); }return undefined; };
    expect(await f.provider.applyWrite(operation(args), guard)).toMatchObject({ details: { rule_readback: 'VERIFIED_NATIVE_ECHO', processed: false } });expect(f.writes()[0]!.body!.rule_spec).toEqual(input.rule_spec);
  });
  it.each(['value', 'operator', 'missing-condition'])('retains the created ID when a recognized echo contradicts the approved %s', async mode => {
    const f = audienceAuthoringFixture(), args = await f.createRule(filtered());f.sourceState.hook = ({ url: target }) => { if (target.pathname.endsWith('/custom_audience/get/') && f.sourceState.mutated) { const row = f.state.rows.find(row => row.audience_id === NEW_CUSTOM_AUDIENCE)!, rule = JSON.parse(row.rule), action = event({ rule_spec: rule });if (mode === 'value') action.parameter_filters[0].values = ['/changed'];else if (mode === 'operator') action.parameter_filters[0].operator = 'EQ';else delete action.parameter_filters;row.rule = JSON.stringify(rule); }return undefined; };
    await expect(f.provider.applyWrite(operation(args), guard)).rejects.toMatchObject({ details: { resourceIds: [NEW_CUSTOM_AUDIENCE] } });expect(f.writes()).toHaveLength(1);
  });
  it.each(['value', 'operator', 'value-order'])('binds the exact %s selection in context hashes before creation', async mode => {
    const f = audienceAuthoringFixture(), args = await f.createRule(filtered()), condition = event(args).parameter_filters[0];if (mode === 'value') condition.values = ['/changed'];else if (mode === 'operator') condition.operator = 'EQ';else condition.values.reverse();
    await expect(f.provider.applyWrite(operation(args), guard)).rejects.toMatchObject({ code: 'PENDING_MISMATCH' });expect(f.writes()).toHaveLength(0);
  });
  it('keeps parameter conditions inside exact shared preview/apply approval and consumes it once', async () => {
    const f = audienceAuthoringFixture(), dir = await mkdtemp(join(tmpdir(), 'tiktok-filter-policy-'));dirs.push(dir);const runtime = await createContext({ engine: new PolicyEngine(DEFAULT_POLICY, new PendingStore(join(dir, 'pending')), new AuditLog(join(dir, 'audit'))), providerModules: [{ provider: f.provider, tools: tiktokTools(f.provider) }] }), args = { account_id: CUSTOM_ACCOUNT, ...await f.createRule(filtered()) }, preview = await runtime.registry.call(tool, args, runtime.ctx) as Row, changed = structuredClone(args);event(changed).parameter_filters[0].values = ['/other'];
    expect(f.writes()).toHaveLength(0);await expect(runtime.registry.call(tool, { ...changed, pending_operation_id: preview.pending_operation_id }, runtime.ctx)).rejects.toThrow();expect(f.writes()).toHaveLength(0);
    expect(await runtime.registry.call(tool, { ...args, pending_operation_id: preview.pending_operation_id }, runtime.ctx)).toMatchObject({ status: 'applied', result: { details: { processed: false, membership_verified: false } } });await expect(runtime.registry.call(tool, { ...args, pending_operation_id: preview.pending_operation_id }, runtime.ctx)).rejects.toThrow();expect(f.writes()).toHaveLength(1);
  });
});
