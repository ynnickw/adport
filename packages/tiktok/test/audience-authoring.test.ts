import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AuditLog, createContext, DEFAULT_POLICY, PendingStore, PolicyEngine, type WriteOperation } from '@adport/core';
import { tiktokTools } from '../src/tools.js';
import { audienceSourceType, audienceRuleSelection, lookalikeAudienceCreate } from '../src/audience-authoring-schemas.js';
import { audienceAuthoringFixture, ruleInput, sourceIdentity, SOURCE_IDS } from './audience-authoring-fixture.js';
import { CUSTOM_ACCOUNT, CUSTOM_AUDIENCE, NEW_CUSTOM_AUDIENCE } from './custom-audience-fixture.js';

// Official SDK f809c396 + published v1.3 docs refreshed2026-11-06.
// Synthetic native envelopes; no actual provider or host certification.
type Row = Record<string, any>;
const guard = { forcePausedCreation: true }, dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
const ruleTool = 'tiktok_create_rule_audience', lookalikeTool = 'tiktok_create_lookalike_audience', refreshTool = 'tiktok_refresh_lookalike_audiences';
const op = (tool: string, payload: Row): WriteOperation => ({ provider: 'tiktok', accountId: CUSTOM_ACCOUNT, kind: tool === refreshTool ? 'update' : 'create', tool, payload });
const sourceInput = (type: string) => ({ account_id: CUSTOM_ACCOUNT, source_type: type, ...(type.includes('VIDEO') ? sourceIdentity : {}) });

describe('TikTok audience event-source proofs', () => {
  it.each(audienceSourceType.options)('discovers and positively verifies %s sources without leaking unrelated native fields', async type => {
    const f = audienceAuthoringFixture(), input = ruleInput(type), context = await f.context(input);expect(context.selected_sources_verified).toBe(true);expect(context.records).toHaveLength(1);expect(context.context_hash).toMatch(/^[a-f0-9]{64}$/);expect(JSON.stringify(context)).not.toContain('PRIVATE');expect(f.writes()).toHaveLength(0);
    if (type !== 'LEAD_GENERATION') { const list = await f.provider.audienceSources.list(sourceInput(type));expect(list.sources[0]!.id).toBe(SOURCE_IDS[type]); }
    if (type === 'BUSINESS_ACCOUNT') expect(f.calls.some(call => call.url.pathname.endsWith('/oauth2/advertiser/get/'))).toBe(true);
  });
  it('preserves modern core_user_id and never substitutes the old numeric id response', async () => {
    const f = audienceAuthoringFixture();f.sourceState.user = { id: 75960823000, email: 'PRIVATE@example.invalid' };await expect(f.context(ruleInput('BUSINESS_ACCOUNT'))).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });expect(f.writes()).toHaveLength(0);
    f.sourceState.authorized = [];await expect(f.context(ruleInput('LEAD_GENERATION'))).rejects.toThrow();
  });
  it('pages unpaged app snapshots and native ad-group pages without changing the source selection', async () => {
    const f = audienceAuthoringFixture();f.sourceState.apps.push({ ...f.sourceState.apps[0], app_id: 'second', app_name: 'Second app' });const input = { ...sourceInput('APP'), page_size: 1 }, first = await f.provider.audienceSources.list(input);expect(first.next_cursor).toBeTruthy();expect((await f.provider.audienceSources.list({ ...input, cursor: first.next_cursor })).records[0]!.name).toBe('Second app');
    await expect(f.provider.audienceSources.list({ ...input, account_id: '123', cursor: first.next_cursor })).rejects.toThrow('selection changed');f.sourceState.apps[1]!.app_name = 'Changed';await expect(f.provider.audienceSources.list({ ...input, cursor: first.next_cursor })).rejects.toThrow('inventory changed');
    f.sourceState.groups.push({ ...f.sourceState.groups[0], adgroup_id: '3002', adgroup_name: 'Second group' });const nativeInput = { ...sourceInput('ENGAGEMENT'), page_size: 1 }, nativeFirst = await f.provider.audienceSources.list(nativeInput);expect((await f.provider.audienceSources.list({ ...nativeInput, cursor: nativeFirst.next_cursor })).records[0]!.name).toBe('Second group');expect(f.calls.at(-1)!.url.searchParams.get('fields')).toBe(JSON.stringify(['advertiser_id', 'adgroup_id', 'adgroup_name', 'campaign_id']));
  });
  it('verifies selected pixels across pages and does not claim unselected pixels matched an ID filter', async () => {
    const f = audienceAuthoringFixture();f.sourceState.pixels = Array.from({ length: 21 }, (_, index) => ({ pixel_id: String(1001 + index), pixel_name: 'Pixel ' + index, advertiser_id: CUSTOM_ACCOUNT }));const input = ruleInput();input.rule_spec.inclusion_rule_set.rules[0].event_source_ids = ['1001', '1021'];expect((await f.context(input)).records.map(row => row.id)).toEqual(['1001', '1021']);
    const data = await f.provider.audienceSources.list({ ...sourceInput('PIXEL'), source_ids: ['1001', '1021'] });expect(data.records.map(row => row.id)).toEqual(['1001']);expect(data.complete).toBe(false);expect(data.next_cursor).toBeTruthy();
  });
  it.each(['foreign-app', 'foreign-group', 'foreign-pixel', 'foreign-offline', 'missing-source', 'duplicate', 'missing-pagination', 'private-video', 'wrong-identity-bc', 'unavailable-identity'])('refuses unproven %s source access before writing', async failure => {
    const f = audienceAuthoringFixture();let input = ruleInput();
    if (failure === 'foreign-app') { input = ruleInput('APP');f.sourceState.apps[0]!.advertiser_id = '123'; }
    if (failure === 'foreign-group') { input = ruleInput('ENGAGEMENT');f.sourceState.groups[0]!.advertiser_id = '123'; }
    if (failure === 'foreign-pixel') f.sourceState.pixels[0]!.advertiser_id = '123';if (failure === 'foreign-offline') { input = ruleInput('OFFLINE');f.sourceState.offline[0]!.advertiser_id = '123'; }
    if (failure === 'missing-source') input.rule_spec.inclusion_rule_set.rules[0].event_source_ids = ['999'];if (failure === 'duplicate') f.sourceState.pixels.push({ ...f.sourceState.pixels[0] });
    if (failure === 'missing-pagination') { input.rule_spec.inclusion_rule_set.rules[0].event_source_ids = ['1001', '999'];f.sourceState.hook = ({ url }) => url.pathname.endsWith('/pixel/list/') ? Response.json({ code: 0, data: { pixels: f.sourceState.pixels } }) : undefined; }
    if (failure.includes('identity') || failure === 'private-video') { input = ruleInput('ENGAGEMENT_ORGANIC_VIDEO');if (failure === 'private-video') f.sourceState.videos[0]!.status = 'ITEM_STATUS_ONLY_AUTHOR_SEE';if (failure === 'wrong-identity-bc') f.sourceState.identities[0]!.identity_authorized_bc_id = '999';if (failure === 'unavailable-identity') f.sourceState.identities[0]!.available_status = 'SCOPE_UNAVAILABLE'; }
    await expect(f.context(input)).rejects.toThrow();expect(f.writes()).toHaveLength(0);
  });
  it('preserves multiple advertiser-authorized BC references for a shop without inventing duplicate event sources', async () => {
    const f = audienceAuthoringFixture();f.sourceState.stores.push({ ...f.sourceState.stores[0], store_authorized_bc_id: '6002' });const result = await f.context(ruleInput('TIKTOK_SHOP'));expect(result.records).toHaveLength(1);expect(result.sources[0]!.configuration.authorized_business_centers).toEqual(['6001', '6002']);
  });
  it('binds video pagination to the exact identity, rejects non-advancing cursors and keeps native500-window limits explicit', async () => {
    const f = audienceAuthoringFixture();f.sourceState.hook = ({ url }) => url.pathname.endsWith('/identity/video/get/') ? Response.json({ code: 0, data: { video_list: f.sourceState.videos, has_more: true, cursor: url.searchParams.get('cursor') } }) : undefined;await expect(f.provider.audienceSources.list(sourceInput('ENGAGEMENT_ORGANIC_VIDEO'))).rejects.toThrow('pagination');
    f.sourceState.hook = undefined;const result = await f.provider.audienceSources.list(sourceInput('ENGAGEMENT_ORGANIC_VIDEO'));const call = [...f.calls].reverse().find(call => call.url.pathname.endsWith('/identity/video/get/'))!;expect(call.url.searchParams.get('exclude_adsonly')).toBe('true');expect(call.url.searchParams.get('item_type')).toBe('VIDEO');expect(result.notes[0]).toContain('500');
  });
  it('supports chunking one native live-video page with stable snapshot/identity cursors', async () => {
    const f = audienceAuthoringFixture();f.sourceState.live.push({ live_id: '9002', finish_timestamp: '2026-11-02 12:00:00' });const input = { ...sourceInput('ENGAGEMENT_LIVE_VIDEO'), page_size: 1 }, first = await f.provider.audienceSources.list(input), second = await f.provider.audienceSources.list({ ...input, cursor: first.next_cursor });expect(second.records[0]!.id).toBe('9002');expect(second.complete).toBe(true);await expect(f.provider.audienceSources.list({ ...input, identity_id: 'other', cursor: first.next_cursor })).rejects.toThrow('selection changed');
  });
  it('keeps native identity aliases, numeric pagination and returned BC references without granting access', async () => {
    const f = audienceAuthoringFixture();f.sourceState.identities.push({ ...sourceIdentity, identity_id: 'other', identity_authorized_bc_id: '6002', display_name: 'Other linked identity' });const result = await f.provider.audienceSources.identities({ account_id: CUSTOM_ACCOUNT, identity_type: 'BC_AUTH_TT', identity_authorized_bc_id: '6001', page_size: 1 });expect(result.complete).toBe(false);expect(result.next_page).toBe(2);expect(result.identity_list[0]!.identity_id).toBe(sourceIdentity.identity_id);expect(f.writes()).toHaveLength(0);
  });
});

describe('TikTok rule audiences', () => {
  it.each(audienceSourceType.options)('creates %s with exact native fields and independent owned metadata, leaving processing separate', async type => {
    const f = audienceAuthoringFixture(), args = await f.createRule(ruleInput(type)), preview = await f.provider.previewWrite(op(ruleTool, args), guard);expect(f.writes()).toHaveLength(0);expect(preview.serverValidated).toBe(false);expect(preview.review?.title).toBe('Create rule audience');const result = await f.provider.applyWrite(op(ruleTool, args), guard), body = f.writes()[0]!.body!;
    expect(f.writes()).toHaveLength(1);expect(f.writes()[0]!.url.pathname).toBe('/open_api/v1.3/dmp/custom_audience/rule/create/');expect(body).toMatchObject({ advertiser_id: CUSTOM_ACCOUNT, audience_type: type, rule_spec: args.rule_spec, is_auto_refresh: false, audience_enhancement: false, audience_sub_type: 'NORMAL' });expect(body).not.toHaveProperty('expected_context_hash');expect(body).not.toHaveProperty('acknowledge_all_event_sources');
    expect(result).toMatchObject({ resourceIds: [NEW_CUSTOM_AUDIENCE], details: { status: 'ACCEPTED_FOR_PROCESSING', processed: false, rule_readback: 'VERIFIED_NATIVE_ECHO', membership_verified: false, source_selection_verified: true, type_mapping_verified: type !== 'OFFLINE' } });
  });
  it('requires explicit all-source scope, keeps exclusion logic and sends no invented source IDs', async () => {
    const f = audienceAuthoringFixture(), input = ruleInput('ENGAGEMENT');delete input.rule_spec.inclusion_rule_set.rules[0].event_source_ids;expect(audienceRuleSelection.safeParse(input).success).toBe(false);input.acknowledge_all_event_sources = true;input.rule_spec.exclusion_rule_set = { operator: 'OR', rules: [{ event_source_ids: ['3001'], retention_days: 7, filter_set: { operator: 'OR', filters: [{ field: 'EVENT', operator: 'EQ', value: 'CLICK' }] } }] };
    const args = await f.createRule(input), preview = await f.provider.previewWrite(op(ruleTool, args), guard);expect(JSON.stringify(preview)).toContain('Exclude any');await f.provider.applyWrite(op(ruleTool, args), guard);const body = f.writes()[0]!.body!;expect(body.rule_spec.inclusion_rule_set.rules[0]).not.toHaveProperty('event_source_ids');expect(body.rule_spec.exclusion_rule_set.rules[0].event_source_ids).toEqual(['3001']);
  });
  it('rejects undocumented nesting/overbroad source requests and enforces documented identity/lookback constraints', () => {
    const input = ruleInput('ENGAGEMENT_ORGANIC_VIDEO');input.rule_spec.inclusion_rule_set.rules[0].retention_days = 90;expect(audienceRuleSelection.safeParse(input).success).toBe(false);input.rule_spec.inclusion_rule_set.rules[0].retention_days = 30;delete input.identity_authorized_bc_id;expect(audienceRuleSelection.safeParse(input).success).toBe(false);
    const lead = ruleInput('LEAD_GENERATION');lead.rule_spec.inclusion_rule_set.rules[0].event_source_ids = ['123'];expect(audienceRuleSelection.safeParse(lead).success).toBe(false);
    const pixel = ruleInput();pixel.rule_spec.inclusion_rule_set.rules[0].filter_set.filters[0].parameter_filters = [{ field: 'URL', operator: 'CONTAINS', values: ['foo'] }];expect(audienceRuleSelection.safeParse(pixel).success).toBe(false);
  });
  it('rechecks source metadata/permissions immediately before apply and refuses stale contexts', async () => {
    const f = audienceAuthoringFixture(), args = await f.createRule();f.sourceState.pixels[0]!.pixel_name = 'Changed';await expect(f.provider.applyWrite(op(ruleTool, args), guard)).rejects.toThrow('changed');expect(f.writes()).toHaveLength(0);
    const video = await f.createRule(ruleInput('ENGAGEMENT_ORGANIC_VIDEO'));f.sourceState.identities[0]!.available_status = 'SCOPE_UNAVAILABLE';await expect(f.provider.applyWrite(op(ruleTool, video), guard)).rejects.toThrow();expect(f.writes()).toHaveLength(0);
  });
  it('does not guess the published legacy rule representation and rejects contradictory recognized echoes', async () => {
    const f = audienceAuthoringFixture();f.sourceState.echo = 'legacy';expect(await f.provider.applyWrite(op(ruleTool, await f.createRule()), guard)).toMatchObject({ details: { rule_readback: 'UNCONFIRMED_NATIVE_REPRESENTATION', processed: false } });
    const wrong = audienceAuthoringFixture();wrong.sourceState.echo = 'wrong';await expect(wrong.provider.applyWrite(op(ruleTool, await wrong.createRule()), guard)).rejects.toMatchObject({ details: { resourceIds: [NEW_CUSTOM_AUDIENCE] } });expect(wrong.writes()).toHaveLength(1);
  });
  it.each(['native', 'transport', 'missing-id', 'wrong-owner', 'processing-error'])('retains known IDs without echoing/replaying %s creation failures', async mode => {
    const f = audienceAuthoringFixture(), args = await f.createRule();f.sourceState.hook = ({ url, init }) => {
      if (init.method === 'POST') { if (mode === 'transport') throw new Error('PRIVATE-native');if (mode === 'native') return Response.json({ code: 40001, message: 'PRIVATE-native' });if (mode === 'missing-id') return Response.json({ code: 0, data: {} }); }
      if (url.pathname.endsWith('/custom_audience/get/') && f.sourceState.mutated) { const row = f.state.rows.find(row => row.audience_id === NEW_CUSTOM_AUDIENCE)!;if (mode === 'wrong-owner') row.owner_id = '123';if (mode === 'processing-error') row.error_msg = 'PRIVATE-native'; }return undefined;
    };
    let error: any;try { await f.provider.applyWrite(op(ruleTool, args), guard); } catch (caught) { error = caught; }expect(error).toBeInstanceOf(Error);expect(String(error)).not.toContain('PRIVATE-native');expect(f.writes()).toHaveLength(1);if (['wrong-owner', 'processing-error'].includes(mode)) expect(error.details.resourceIds).toEqual([NEW_CUSTOM_AUDIENCE]);
  });
});

describe('TikTok lookalike creation and refresh', () => {
  it('uses current v1.3 fields and verifies a recognized native spec echo with scalar placement', async () => {
    const f = audienceAuthoringFixture(), args = await f.lookalike(), preview = await f.provider.previewWrite(op(lookalikeTool, args), guard);expect(f.writes()).toHaveLength(0);expect(preview.review?.fields).toContainEqual({ label: 'Include seed members', after: false });const result = await f.provider.applyWrite(op(lookalikeTool, args), guard);expect(f.writes()[0]!.body).toEqual({ advertiser_id: CUSTOM_ACCOUNT, custom_audience_name: 'QA lookalike', lookalike_spec: args.lookalike_spec });expect(result).toMatchObject({ details: { specification_readback: 'VERIFIED_NATIVE_ECHO', status: 'ACCEPTED_FOR_PROCESSING', processed: false } });
    expect(lookalikeAudienceCreate.safeParse({ ...args, lookalike_spec: { ...args.lookalike_spec, system: 'ALL' } }).success).toBe(false);
  });
  it.each(['small', 'missing-count', 'lookalike-seed', 'unavailable', 'expiring', 'unknown-access', 'stale'])('rejects an unproven %s seed before creation', async failure => {
    const f = audienceAuthoringFixture(), args = await f.lookalike(), row = f.state.rows[0]!;if (failure === 'small') row.cover_num = 99;if (failure === 'missing-count') delete row.cover_num;if (failure === 'lookalike-seed') row.type = 'Lookalike Audience';if (failure === 'unavailable') row.is_valid = false;if (failure === 'expiring') row.is_expiring = true;if (failure === 'unknown-access') delete row.is_creator;if (failure === 'stale') row.name = 'Changed';await expect(f.provider.applyWrite(op(lookalikeTool, args), guard)).rejects.toThrow();expect(f.writes()).toHaveLength(0);
  });
  it('permits an explicitly shared available seed without claiming ownership or changing its grant', async () => {
    const f = audienceAuthoringFixture();Object.assign(f.state.rows[0]!, { is_creator: false, owner_id: '123', shared: true });const args = await f.lookalike();await f.provider.previewWrite(op(lookalikeTool, args), guard);expect(f.writes()).toHaveLength(0);expect(f.state.rows[0]!.owner_id).toBe('123');
  });
  it('leaves missing native spec representations unverified and rejects recognized mismatches without a new create', async () => {
    const f = audienceAuthoringFixture();f.sourceState.echo = 'legacy';expect(await f.provider.applyWrite(op(lookalikeTool, await f.lookalike()), guard)).toMatchObject({ details: { specification_readback: 'UNCONFIRMED_NATIVE_REPRESENTATION' } });const wrong = audienceAuthoringFixture();wrong.sourceState.echo = 'wrong';await expect(wrong.provider.applyWrite(op(lookalikeTool, await wrong.lookalike()), guard)).rejects.toMatchObject({ details: { resourceIds: [NEW_CUSTOM_AUDIENCE] } });expect(wrong.writes()).toHaveLength(1);
  });
  it('batch-checks every target before one refresh and independently verifies preserved metadata', async () => {
    const f = audienceAuthoringFixture();f.state.rows[0]!.type = 'Lookalike Audience';f.state.rows.push({ ...f.state.rows[0], audience_id: NEW_CUSTOM_AUDIENCE, name: 'Second lookalike' });const rows = await f.provider.customAudiences.inspect(CUSTOM_ACCOUNT, [CUSTOM_AUDIENCE, NEW_CUSTOM_AUDIENCE]), args = { targets: rows.map(row => ({ custom_audience_id: row.audience_id, expected_snapshot_hash: row.snapshot_hash })), acknowledge_shared_effects: true };f.calls.length = 0;const result = await f.provider.applyWrite(op(refreshTool, args), guard);expect(f.writes()).toHaveLength(1);expect(f.writes()[0]!.body).toEqual({ advertiser_id: CUSTOM_ACCOUNT, custom_audience_ids: [CUSTOM_AUDIENCE, NEW_CUSTOM_AUDIENCE] });expect(f.calls.filter(call => call.url.pathname.endsWith('/custom_audience/get/'))).toHaveLength(3);expect(result).toMatchObject({ details: { metadata_preservation: 'VERIFIED', accepted_count: 2, processed: false, membership_verified: false, results: expect.arrayContaining([{ id: CUSTOM_AUDIENCE, status: 'ACCEPTED_FOR_PROCESSING', native_is_valid: false }]) } });
  });
  it('refuses a recipient/non-lookalike/stale refresh target before any member changes', async () => {
    const f = audienceAuthoringFixture(), row = (await f.get()).audience;await expect(f.provider.previewWrite(op(refreshTool, { targets: [{ custom_audience_id: row.audience_id, expected_snapshot_hash: row.snapshot_hash }], acknowledge_shared_effects: true }), guard)).rejects.toThrow('Lookalike');Object.assign(f.state.rows[0]!, { type: 'Lookalike Audience', is_creator: false, owner_id: '123', shared: true });const recipient = (await f.get()).audience;await expect(f.provider.previewWrite(op(refreshTool, { targets: [{ custom_audience_id: recipient.audience_id, expected_snapshot_hash: recipient.snapshot_hash }], acknowledge_shared_effects: true }), guard)).rejects.toThrow('recipient');expect(f.writes()).toHaveLength(0);
  });
  it('uses shared exact-argument policy approval, consumes it once, and preserves failure audit IDs', async () => {
    const f = audienceAuthoringFixture(), dir = await mkdtemp(join(tmpdir(), 'tiktok-authoring-policy-'));dirs.push(dir);const runtime = await createContext({ engine: new PolicyEngine(DEFAULT_POLICY, new PendingStore(join(dir, 'pending')), new AuditLog(join(dir, 'audit'))), providerModules: [{ provider: f.provider, tools: tiktokTools(f.provider) }] }), args = { account_id: CUSTOM_ACCOUNT, ...await f.lookalike() }, preview = await runtime.registry.call(lookalikeTool, args, runtime.ctx) as Row;
    await expect(runtime.registry.call(lookalikeTool, { ...args, custom_audience_name: 'Other', pending_operation_id: preview.pending_operation_id }, runtime.ctx)).rejects.toThrow();expect(f.writes()).toHaveLength(0);await runtime.registry.call(lookalikeTool, { ...args, pending_operation_id: preview.pending_operation_id }, runtime.ctx);await expect(runtime.registry.call(lookalikeTool, { ...args, pending_operation_id: preview.pending_operation_id }, runtime.ctx)).rejects.toThrow();expect(f.writes()).toHaveLength(1);const logs = (await Promise.all((await readdir(join(dir, 'audit'))).map(file => readFile(join(dir, 'audit', file), 'utf8')))).join('');expect(logs).toContain(NEW_CUSTOM_AUDIENCE);expect(logs).not.toContain('PRIVATE');
  });
});
