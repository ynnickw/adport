import { createHash } from 'node:crypto';
import { AdportError, type WriteOperation, type WritePreview, type WriteResult } from '@adport/core';
import { z } from 'zod';
import type { SpotifyAdsClient } from './client.js';
import { spotifyId } from './schemas.js';
import { capiSchema, createdReceipt, createCapi, createDataset, createMobile, createPixel, datasetSchema, datasetSharing, diagnosticSchema, mobileSchema, mobileSharing, paging, pixelId, pixelSchema, removeIntegration, updateCapi, updateDataset, updateMobile, updatePixel } from './measurement-schemas.js';

type Row = Record<string, unknown>;
type Scope = { account_id: string; business_id: string };
type Dataset = z.infer<typeof datasetSchema>;
type Mobile = z.infer<typeof mobileSchema>;
type Receipt = z.infer<typeof createdReceipt>;
interface Plan extends Omit<WritePreview, 'serverValidated'> { execute(): Promise<WriteResult> }
const RECEIPT_TTL = 7 * 24 * 60 * 60;
const commonNotes = ['Local preview only. Measurement resource management does not install website code, send conversion events, issue CAPI credentials or change ad delivery or budgets.', 'Native permissions and configuration remain authoritative. No automatic write retry; use the returned IDs and signed receipt to reconcile partial creation.'];
const canonical = (value: unknown): string => JSON.stringify(value, (key, item) => {
  if (Array.isArray(item) && ['aam_fields', 'auto_capture_fields', 'shared_ad_accounts'].includes(key)) return item.map(v => v && typeof v === 'object' && 'id' in v ? { id: v.id } : v).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).filter(([k]) => !['events', 'events_received', 'historical_events', 'created_at', 'updated_at', 'ad_set_count', 'is_receiving_events', 'is_receiving_lead_events'].includes(k)).sort(([a], [b]) => a.localeCompare(b))) : item;
});
const digest = (scope: Scope, kind: string, value: unknown) => createHash('sha256').update(canonical({ ...scope, kind, configuration: value })).digest('hex');
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const members = (dataset: Dataset) => [dataset.pixel, dataset.capi_integration].filter((v): v is NonNullable<typeof v> => Boolean(v));
const contains = (dataset: Dataset, integration: string) => members(dataset).some(v => v.integration_id === integration);
function params(input: Row) { const p = new URLSearchParams();for (const [k, v] of Object.entries(input)) if (v !== undefined) { if (Array.isArray(v)) for (const value of v) p.append(k, String(value)); else p.set(k, String(v)); } return p; }
function ensure(value: unknown, message: string): asserts value { if (!value) throw new AdportError('PROVIDER_ERROR', `spotify: ${message}`); }

/** Current official v3 OpenAPI, fetched 2026-11-05; signed recovery follows approved native creations only. */
export class SpotifyMeasurementService {
  constructor(private readonly client: SpotifyAdsClient) {}
  private base(scope: Scope) { return `businesses/${scope.business_id}`; }
  private async scope(account: string): Promise<Scope> {
    const id = spotifyId.parse(account), data = await this.client.get(`ad_accounts/${id}`, z.object({ id: spotifyId, business_id: spotifyId }));
    ensure(data.id === id, 'measurement account identity mismatch');
    return { account_id: id, business_id: data.business_id };
  }
  private proof(account: string, value?: string, purpose: Receipt['purpose'] = 'creation'): Receipt | undefined {
    if (!value) return undefined;
    const parsed = createdReceipt.safeParse(this.client.verifyMeasurementReceipt(value)), now = Math.floor(Date.now() / 1000);
    if (!parsed.success || parsed.data.purpose !== purpose || parsed.data.account_id !== account || parsed.data.issued_at > now + 60 || parsed.data.expires_at <= now || parsed.data.expires_at <= parsed.data.issued_at || parsed.data.expires_at - parsed.data.issued_at > RECEIPT_TTL) throw new AdportError('INVALID_INPUT', 'spotify: expired or mismatched measurement resource receipt');
    return parsed.data;
  }
  private bind(scope: Scope, kind: Receipt['kind'], id: string, datasetId?: string, purpose: Receipt['purpose'] = 'creation'): string {
    const now = Math.floor(Date.now() / 1000);
    return this.client.measurementReceipt(createdReceipt.parse({ version: 1, purpose, ...scope, kind, id, ...(datasetId ? { dataset_id: datasetId } : {}), issued_at: now, expires_at: now + RECEIPT_TTL }));
  }
  private checkProof(scope: Scope, proof?: Receipt) { if (proof && proof.business_id !== scope.business_id) throw new AdportError('INVALID_INPUT', 'spotify: the account business changed; measurement receipt no longer matches'); }
  private async rawDataset(scope: Scope, id: string) {
    const data = await this.client.get(`${this.base(scope)}/datasets/${spotifyId.parse(id)}`, datasetSchema);ensure(data.id === id, 'dataset identity mismatch');return data;
  }
  private async rawMobile(scope: Scope, id: string) {
    const data = await this.client.get(`${this.base(scope)}/mobile_apps/${spotifyId.parse(id)}`, mobileSchema);ensure(data.id === id, 'mobile-app identity mismatch');return data;
  }
  private async rawPixel(scope: Scope, id: string) {
    const data = await this.client.get(`${this.base(scope)}/pixels/${id}`, pixelSchema);ensure(data.id === id, 'Pixel identity mismatch');return data;
  }
  private async rawCapi(scope: Scope, id: string) {
    const data = await this.client.get(`${this.base(scope)}/capi/${spotifyId.parse(id)}`, capiSchema);ensure(data.capi_connection_id === id, 'CAPI integration identity mismatch');return data;
  }
  private datasetContainsResource(dataset: Dataset, kind: Receipt['kind'], id: string) {
    return kind === 'pixel' ? dataset.pixel?.id === id : kind === 'capi' ? dataset.capi_integration?.capi_connection_id === id : false;
  }
  private verifyIntegrationBinding(dataset: Dataset, kind: 'pixel' | 'capi', id: string, observed: string | null | undefined) {
    ensure(this.datasetContainsResource(dataset, kind, id) && (observed == null || observed === dataset.id), `${kind === 'pixel' ? 'Pixel' : 'CAPI'} dataset binding mismatch`);
  }
  private async receiptNative(scope: Scope, proof: Receipt) {
    this.checkProof(scope, proof);
    const resource = proof.kind === 'pixel' ? await this.rawPixel(scope, proof.id) : proof.kind === 'capi' ? await this.rawCapi(scope, proof.id) : proof.kind === 'mobile_app' ? await this.rawMobile(scope, proof.id) : await this.rawDataset(scope, proof.id);
    const datasetId = proof.kind === 'dataset' ? proof.id : 'dataset_id' in resource && typeof resource.dataset_id === 'string' ? resource.dataset_id : undefined;
    let expectedDataset: Dataset | undefined, verifiedDatasetId = datasetId;
    let parentVerificationError: { code: string; http_status?: number } | undefined;
    // Null is missing evidence, not a conflicting edge. Inspect only the parent locked by the native creation receipt.
    if (!datasetId && proof.dataset_id && ['pixel', 'capi'].includes(proof.kind)) {
      try {
        expectedDataset = await this.rawDataset(scope, proof.dataset_id);
        if (this.datasetContainsResource(expectedDataset, proof.kind, proof.id)) verifiedDatasetId = expectedDataset.id;
      } catch (error) {
        if (!(error instanceof AdportError)) throw error;
        const status = error.details && typeof error.details === 'object' && 'http_status' in error.details ? error.details.http_status : undefined;
        parentVerificationError = { code: error.code, ...(typeof status === 'number' ? { http_status: status } : {}) };
      }
    }
    return { resource, datasetId, verifiedDatasetId, expectedDataset, parentVerificationError };
  }
  private async createdNative(scope: Scope, proof: Receipt) {
    const { resource, verifiedDatasetId } = await this.receiptNative(scope, proof);
    ensure(!proof.dataset_id || verifiedDatasetId === proof.dataset_id, 'created resource dataset binding changed; reconcile the original IDs');
    return { resource, datasetId: verifiedDatasetId };
  }
  private sharing(scope: Scope, row: { shared_ad_accounts?: Array<{ id: string; name?: string | null }> | null }) {
    return { shared_ad_accounts: row.shared_ad_accounts === null ? null : row.shared_ad_accounts?.filter(a => a.id === scope.account_id), other_shared_account_count: row.shared_ad_accounts ? row.shared_ad_accounts.filter(a => a.id !== scope.account_id).length : null };
  }
  private publicDataset(scope: Scope, row: Dataset, snapshot = true) { return { ...row, ...this.sharing(scope, row), ...(snapshot ? { configuration_hash: digest(scope, 'dataset', row) } : {}) }; }
  private publicMobile(scope: Scope, row: Mobile, snapshot = true) { return { ...row, ...this.sharing(scope, row), ...(snapshot ? { configuration_hash: digest(scope, 'mobile_app', row) } : {}) }; }
  private async selectedDatasets(scope: Scope) {
    // This endpoint has no documented limit/offset query; never invent paging parameters.
    const data = await this.client.get(`${this.base(scope)}/ad_accounts/${scope.account_id}/datasets`, z.object({ datasets: z.array(datasetSchema), paging: paging.nullish() }));
    ensure(new Set(data.datasets.map(d => d.id)).size === data.datasets.length, 'dataset inventory repeated an ID');
    ensure(!data.paging || data.paging.offset === 0 && data.paging.total_results >= data.datasets.length, 'dataset inventory pagination is inconsistent');
    for (const row of data.datasets) ensure(!row.shared_ad_accounts || row.shared_ad_accounts.some(a => a.id === scope.account_id), 'dataset inventory contains an unshared account resource');
    return { ...data, complete: data.paging ? data.paging.total_results === data.datasets.length : null, truncated: !data.paging || data.paging.total_results !== data.datasets.length };
  }
  private recoverableDataset(scope: Scope, row: Dataset, proof: Receipt, nativeDatasetId?: string) {
    if (nativeDatasetId !== row.id) return false;
    if (proof.dataset_id === row.id || proof.kind === 'dataset' && proof.id === row.id) return true;
    // An initially unbound creation cannot be used to pivot into an unrelated shared parent.
    if (!row.shared_ad_accounts || row.shared_ad_accounts.some(a => a.id !== scope.account_id)) return false;
    return proof.kind === 'pixel' ? row.pixel?.id === proof.id && !row.capi_integration : proof.kind === 'capi' ? row.capi_integration?.capi_connection_id === proof.id && !row.pixel : false;
  }
  private async dataset(scope: Scope, id: string, proof?: Receipt) {
    this.checkProof(scope, proof);
    const row = await this.rawDataset(scope, id);
    if (row.shared_ad_accounts?.some(a => a.id === scope.account_id)) return row;
    if (proof && this.recoverableDataset(scope, row, proof, (await this.createdNative(scope, proof)).datasetId)) return row;
    if (!row.shared_ad_accounts) {
      const selected = (await this.selectedDatasets(scope)).datasets.find(d => d.id === id);
      if (selected) return { ...row, ...(selected.shared_ad_accounts ? { shared_ad_accounts: selected.shared_ad_accounts } : {}) };
    }
    throw new AdportError('INVALID_INPUT', 'spotify: dataset is not shared with the selected account; an unshared creation requires its signed resource receipt');
  }
  private async mobile(scope: Scope, id: string, proof?: Receipt) {
    this.checkProof(scope, proof);const row = await this.rawMobile(scope, id);
    if (row.shared_ad_accounts?.some(a => a.id === scope.account_id) || proof?.kind === 'mobile_app' && proof.id === id) return row;
    if (!row.shared_ad_accounts) {
      const seen = new Set<string>();
      for (let offset = 0, page = 0; page < 1000; page++) {
        const data = await this.mobilePage(scope, { limit: 50, offset });
        for (const item of data.mobile_apps) { ensure(!seen.has(item.id), 'mobile-app inventory repeated a page');seen.add(item.id); }
        const selected = data.mobile_apps.find(a => a.id === id);
        if (selected) return { ...row, ...(selected.shared_ad_accounts ? { shared_ad_accounts: selected.shared_ad_accounts } : {}) };
        if (!data.truncated) break;offset = data.next_offset!;
      }
    }
    throw new AdportError('INVALID_INPUT', 'spotify: mobile app is not shared with the selected account or bound to its approved creation receipt');
  }
  private exclusive(scope: Scope, row: { shared_ad_accounts?: Array<{ id: string }> | null }) {
    if (!row.shared_ad_accounts || row.shared_ad_accounts.some(a => a.id !== scope.account_id)) throw new AdportError('INVALID_INPUT', 'spotify: business-wide configuration changes require verified sharing restricted to this selected account');
  }
  private expected(scope: Scope, kind: string, value: unknown, hash: string) { if (digest(scope, kind, value) !== hash) throw new AdportError('INVALID_INPUT', 'spotify: measurement configuration changed; obtain a fresh snapshot before a new preview'); }
  private result(ids: string[], details: Row = {}): WriteResult { return { applied: true, resourceIds: [...new Set(ids)], ...(Object.keys(details).length ? { details } : {}) }; }
  private uncertain(ids: string[], receipt?: string): never { throw new AdportError('PROVIDER_ERROR', 'spotify: measurement write/readback unconfirmed; reconcile the original IDs before another mutation. No write was replayed.', { resource_ids: ids, ...(receipt ? { resource_receipt: receipt } : {}) }); }
  private review(scope: Scope, title: string, kind: WriteOperation['kind'], body: Row, current?: Row, notices = commonNotes): Omit<Plan, 'execute'> {
    const fields = Object.entries(body).map(([key, value]) => ({ label: key.replaceAll('_', ' '), ...(current?.[key] === undefined ? {} : { before: current[key] }), after: value }));
    return { summary: title, changes: [`${kind}: ${JSON.stringify(body)}`], notes: notices, coercions: [], budgetDeltas: [], review: { provider: 'spotify', accountId: scope.account_id, kind, title, fields, notices } };
  }

  async datasets(account: string) { const scope = await this.scope(account), data = await this.selectedDatasets(scope);return { ...scope, ...data, datasets: data.datasets.map(d => this.publicDataset(scope, d, false)) }; }
  private async mobilePage(scope: Scope, input: { limit: number; offset: number }) {
    const data = await this.client.get(`${this.base(scope)}/ad_accounts/${scope.account_id}/mobile_apps`, z.object({ mobile_apps: z.array(mobileSchema), paging }), params({ limit: input.limit, offset: input.offset }));
    ensure(data.paging.offset === input.offset && data.mobile_apps.length <= input.limit && (!data.mobile_apps.length || data.paging.total_results >= input.offset + data.mobile_apps.length), 'mobile-app pagination is inconsistent');
    ensure(new Set(data.mobile_apps.map(a => a.id)).size === data.mobile_apps.length, 'mobile-app page repeated an ID');
    for (const row of data.mobile_apps) ensure(!row.shared_ad_accounts || row.shared_ad_accounts.some(a => a.id === scope.account_id), 'mobile-app inventory contains an unshared resource');
    const next = input.offset + data.mobile_apps.length, truncated = next < data.paging.total_results;ensure(!truncated || data.mobile_apps.length > 0, 'mobile-app pagination stalled');
    return { ...data, truncated, ...(truncated ? { next_offset: next } : {}) };
  }
  async mobileApps(input: { account_id: string; limit: number; offset: number }) { const scope = await this.scope(input.account_id), data = await this.mobilePage(scope, input);return { ...scope, ...data, mobile_apps: data.mobile_apps.map(a => this.publicMobile(scope, a, false)) }; }
  async context(account: string) { const scope = await this.scope(account), data = await this.selectedDatasets(scope);return { ...scope, ...data, datasets: data.datasets.map(d => this.publicDataset(scope, d, false)), notes: ['Only datasets shared with this selected account are inventoried. Business-wide resources and other account identities are excluded. Read an individual resource for its full mutation snapshot.', 'Pixel creation may create a dataset; CAPI can join that dataset. No tracking code, tokens or events are created by these reads.'] }; }
  async getDataset(input: { account_id: string; dataset_id: string; resource_receipt?: string }) { const proof = this.proof(input.account_id, input.resource_receipt), scope = await this.scope(input.account_id);return { ...scope, dataset: this.publicDataset(scope, await this.dataset(scope, input.dataset_id, proof)) }; }
  async getPixel(input: { account_id: string; dataset_id: string; resource_receipt?: string }) {
    const proof = this.proof(input.account_id, input.resource_receipt), scope = await this.scope(input.account_id), dataset = await this.dataset(scope, input.dataset_id, proof);ensure(dataset.pixel, 'dataset has no verified Pixel');
    const pixel = await this.rawPixel(scope, dataset.pixel.id);this.verifyIntegrationBinding(dataset, 'pixel', pixel.id, pixel.dataset_id);return { ...scope, pixel: { ...pixel, configuration_hash: digest(scope, 'pixel', pixel) }, dataset_binding: { observed_dataset_id: pixel.dataset_id ?? null, verified_dataset_id: dataset.id, verification_source: pixel.dataset_id ? 'resource' : 'dataset' } };
  }
  async getCapi(input: { account_id: string; dataset_id: string; resource_receipt?: string }) {
    const proof = this.proof(input.account_id, input.resource_receipt), scope = await this.scope(input.account_id), dataset = await this.dataset(scope, input.dataset_id, proof);ensure(dataset.capi_integration, 'dataset has no verified CAPI integration');
    const integration = await this.rawCapi(scope, dataset.capi_integration.capi_connection_id);this.verifyIntegrationBinding(dataset, 'capi', integration.capi_connection_id, integration.dataset_id);return { ...scope, capi_integration: { ...integration, configuration_hash: digest(scope, 'capi', integration) }, dataset_binding: { observed_dataset_id: integration.dataset_id ?? null, verified_dataset_id: dataset.id, verification_source: integration.dataset_id ? 'resource' : 'dataset' } };
  }
  async getMobile(input: { account_id: string; mobile_app_id: string; resource_receipt?: string }) { const proof = this.proof(input.account_id, input.resource_receipt), scope = await this.scope(input.account_id);return { ...scope, mobile_app: this.publicMobile(scope, await this.mobile(scope, input.mobile_app_id, proof)) }; }
  async diagnostics(input: { account_id: string; dataset_id: string; granularities: Array<'DAILY' | 'HOURLY'>; datasource_ids?: string[]; resource_receipt?: string }) {
    const proof = this.proof(input.account_id, input.resource_receipt), scope = await this.scope(input.account_id);await this.dataset(scope, input.dataset_id, proof);
    const data = await this.client.get(`${this.base(scope)}/datasets/${input.dataset_id}/diagnostics`, diagnosticSchema, params({ granularities: input.granularities, datasource_ids: input.datasource_ids }));
    ensure(data.dataset_id === input.dataset_id && data.datasources.every(d => input.granularities.includes(d.granularity) && (!input.datasource_ids || input.datasource_ids.includes(d.datasource_id))), 'measurement diagnostic identity/filter mismatch');
    return { ...scope, ...data, notes: ['Diagnostics can lag implementation by at least 20 minutes. Received activity is not proof of campaign attribution, optimization or delivery. Missing or suppressed values remain native; this read sends no events.'] };
  }
  async created(input: { account_id: string; resource_receipt: string }) {
    const proof = this.proof(input.account_id, input.resource_receipt)!, scope = await this.scope(input.account_id), native = await this.receiptNative(scope, proof);
    const matches = proof.dataset_id ? native.datasetId === proof.dataset_id : null;
    const verified = !proof.dataset_id || native.verifiedDatasetId === proof.dataset_id;
    const candidate = verified && native.verifiedDatasetId ? native.expectedDataset ?? await this.rawDataset(scope, native.verifiedDatasetId) : undefined;
    const dataset = candidate && (candidate.shared_ad_accounts?.some(a => a.id === scope.account_id) || this.recoverableDataset(scope, candidate, proof, native.verifiedDatasetId)) ? candidate : undefined;
    const key = proof.kind === 'capi' ? 'capi_integration' : proof.kind;
    const resource = proof.kind === 'mobile_app' ? this.publicMobile(scope, native.resource as Mobile) : proof.kind === 'dataset' ? this.publicDataset(scope, native.resource as Dataset) : { ...native.resource, configuration_hash: digest(scope, proof.kind, native.resource) };
    return { ...scope, kind: proof.kind, [key]: resource, dataset: dataset ? this.publicDataset(scope, dataset) : null,
      dataset_binding: { expected_dataset_id: proof.dataset_id ?? null, observed_dataset_id: native.datasetId ?? null, matches_receipt: matches, verified_dataset_id: dataset?.id ?? null, verification_source: dataset ? native.datasetId ? 'resource' : 'dataset' : null, ...(native.parentVerificationError ? { parent_verification_error: native.parentVerificationError } : {}) },
      needs_dataset_sharing: dataset?.shared_ad_accounts ? !dataset.shared_ad_accounts.some(a => a.id === scope.account_id) : null, resource_receipt: input.resource_receipt,
      notes: ['Read-only reconciliation of an approved creation. No creation, share, update or event request was replayed.', ...(matches === false ? [dataset ? 'The native child omits its dataset binding. The exact receipt-bound parent independently confirms the resource relationship; the native null value is preserved.' : 'The resource relationship is unverified. No unexpected dataset contents were followed. Sharing remains unverified and mutation checks remain strict.'] : [])] };
  }
  async sharingStatus(input: { account_id: string; resource_receipt: string }) {
    const proof = this.proof(input.account_id, input.resource_receipt, 'sharing')!, scope = await this.scope(input.account_id);this.checkProof(scope, proof);
    if (!['dataset', 'mobile_app'].includes(proof.kind)) throw new AdportError('INVALID_INPUT', 'spotify: receipt does not identify a sharing operation');
    const row = proof.kind === 'dataset' ? await this.rawDataset(scope, proof.id) : await this.rawMobile(scope, proof.id);
    ensure(row.shared_ad_accounts, 'native sharing state is unavailable');
    return { ...scope, kind: proof.kind, resource_id: proof.id, shared_with_selected_account: row.shared_ad_accounts.some(a => a.id === scope.account_id), other_shared_account_count: row.shared_ad_accounts.filter(a => a.id !== scope.account_id).length, notes: ['Read-only reconciliation of the selected account’s sharing state. A sharing receipt does not grant resource-content access after unsharing.'] };
  }

  private async shareCreatedDataset(scope: Scope, id: string) {
    const current = await this.rawDataset(scope, id);this.exclusive(scope, current);
    if (!current.shared_ad_accounts!.some(a => a.id === scope.account_id)) await this.client.mutate(`${this.base(scope)}/datasets/${id}/ad_accounts/${scope.account_id}`, 'POST', undefined, z.undefined());
    const actual = await this.rawDataset(scope, id);this.exclusive(scope, actual);ensure(actual.shared_ad_accounts!.some(a => a.id === scope.account_id), 'created dataset sharing readback unconfirmed');return actual;
  }
  private async planCreate(op: WriteOperation, scope: Scope, proof?: Receipt): Promise<Plan> {
    const kind: Receipt['kind'] = op.tool === 'spotify_create_pixel' ? 'pixel' : op.tool === 'spotify_create_capi_integration' ? 'capi' : 'mobile_app';
    let body: Row, requestedDataset: string | undefined;
    if (kind === 'mobile_app') body = createMobile.parse(op.payload);
    else {
      const input = kind === 'pixel' ? createPixel.parse(op.payload) : createCapi.parse(op.payload);
      const { expected_dataset_configuration_hash, resource_receipt: _receipt, ...native } = input;
      if (input.dataset_id) {
        const dataset = await this.dataset(scope, input.dataset_id, proof);this.exclusive(scope, dataset);this.expected(scope, 'dataset', dataset, expected_dataset_configuration_hash!);
        if (kind === 'pixel' ? dataset.pixel : dataset.capi_integration) throw new AdportError('INVALID_INPUT', `spotify: dataset already has a ${kind} integration; reuse it instead of duplicating the source`);
      }
      const { acknowledge_advanced_matching: _ack, ...fields } = native as Row;
      body = fields;requestedDataset = input.dataset_id;
    }
    const path = `${this.base(scope)}/${kind === 'pixel' ? 'pixels' : kind === 'capi' ? 'capi' : 'mobile_apps'}`;
    const notices = [...commonNotes, kind === 'mobile_app' ? 'The new mobile-app record will be shared only with this selected ad account. Registration does not install or configure an MMP SDK.' : 'The new integration will use its verified dataset, which will be shared only with this selected ad account. A new native dataset is created when dataset_id is omitted.', ...(kind === 'pixel' ? ['Advanced matching is disabled by default. Native cookie and automatic-capture settings are returned for review before any website installation.'] : [])];
    return { ...this.review(scope, `Create Spotify ${kind.replaceAll('_', ' ')} "${body.name}"`, 'create', body, undefined, notices), execute: async () => {
      let id: string, nativeDataset: string | undefined;
      try {
        if (kind === 'pixel') { const row = await this.client.mutate(path, 'POST', body, z.object({ id: pixelId, dataset_id: z.unknown().optional() }));id = row.id;const dataset = spotifyId.safeParse(row.dataset_id);nativeDataset = dataset.success ? dataset.data : undefined; }
        else if (kind === 'capi') { const row = await this.client.mutate(path, 'POST', body, z.object({ capi_connection_id: spotifyId, dataset_id: z.unknown().optional() }));id = row.capi_connection_id;const dataset = spotifyId.safeParse(row.dataset_id);nativeDataset = dataset.success ? dataset.data : undefined; }
        else { const row = await this.client.mutate(path, 'POST', { mobile_app: body }, z.object({ id: spotifyId, dataset_id: z.unknown().optional() }));id = row.id;const dataset = spotifyId.safeParse(row.dataset_id);nativeDataset = dataset.success ? dataset.data : undefined; }
      } catch (error) { if (error instanceof AdportError && /HTTP (400|401|403|404|409|422)\b/.test(error.message)) throw error;return this.uncertain([]); }
      let receipt = this.bind(scope, kind, id, requestedDataset ?? nativeDataset), knownDataset = requestedDataset ?? nativeDataset;
      try {
        const bound = this.proof(scope.account_id, receipt)!, { resource, datasetId } = await this.createdNative(scope, bound);
        const observed = resource as Row;
        // Spotify returns null for unused matching fields; only verified AAM-off makes them ineffective.
        ensure(Object.entries(body).every(([key, value]) => kind === 'pixel' && key === 'aam_fields' && Array.isArray(value) && !value.length && observed.aam_opt_in === false && observed[key] == null
          || same({ [key]: observed[key] }, { [key]: value })), 'created measurement fields differ from the request');
        ensure(!requestedDataset || datasetId === requestedDataset, 'created integration has a different dataset');
        if (kind === 'mobile_app') {
          const mobile = resource as Mobile;this.exclusive(scope, mobile);
          if (!mobile.shared_ad_accounts!.some(a => a.id === scope.account_id)) await this.client.mutate(`${path}/${id}/ad_accounts/${scope.account_id}`, 'POST', undefined, z.undefined());
          const actual = await this.rawMobile(scope, id);this.exclusive(scope, actual);ensure(actual.shared_ad_accounts!.some(a => a.id === scope.account_id), 'created mobile-app sharing readback unconfirmed');
          receipt = this.bind(scope, kind, id, datasetId);return this.result([id, ...(datasetId ? [datasetId] : [])], { resource_receipt: receipt, next_tool: 'spotify_created_measurement', mobile_app_id: id, ...(datasetId ? { dataset_id: datasetId } : {}) });
        }
        ensure(datasetId, 'created integration has no verified dataset ID');knownDataset = datasetId;receipt = this.bind(scope, kind, id, datasetId);
        const dataset = await this.rawDataset(scope, datasetId);
        ensure(kind === 'pixel' ? dataset.pixel?.id === id : dataset.capi_integration?.capi_connection_id === id, 'created dataset does not bind the returned integration');
        await this.shareCreatedDataset(scope, datasetId);
        return this.result([id, datasetId], { resource_receipt: receipt, next_tool: 'spotify_created_measurement', dataset_id: datasetId });
      } catch { return this.uncertain([id, ...(knownDataset ? [knownDataset] : [])], receipt); }
    } };
  }
  private async planUpdate(op: WriteOperation, scope: Scope, proof?: Receipt): Promise<Plan> {
    let current: Row, body: Row, path: string, kind: string, id: string, readback: () => Promise<Row>;
    if (op.tool === 'spotify_update_mobile_app') {
      const input = updateMobile.parse(op.payload), row = await this.mobile(scope, input.mobile_app_id, proof);this.exclusive(scope, row);this.expected(scope, 'mobile_app', row, input.expected_configuration_hash);
      const { mobile_app_id: _id, resource_receipt: _receipt, expected_configuration_hash: _hash, ...fields } = input;
      current = row;body = fields;kind = 'mobile_app';id = row.id;path = `${this.base(scope)}/mobile_apps/${id}`;readback = () => this.rawMobile(scope, id);
    } else {
      const input = op.tool === 'spotify_update_pixel' ? updatePixel.parse(op.payload) : op.tool === 'spotify_update_capi_integration' ? updateCapi.parse(op.payload) : op.tool === 'spotify_update_dataset' ? updateDataset.parse(op.payload) : undefined;
      if (!input) throw new AdportError('INVALID_INPUT', 'spotify: unsupported measurement update');
      const dataset = await this.dataset(scope, input.dataset_id, proof);this.exclusive(scope, dataset);
      const { dataset_id: _id, resource_receipt: _receipt, expected_configuration_hash: _hash, ...fields } = input;body = fields;
      if (op.tool === 'spotify_update_pixel') {
        ensure(dataset.pixel, 'dataset has no verified Pixel');const pixel = await this.rawPixel(scope, dataset.pixel.id);this.verifyIntegrationBinding(dataset, 'pixel', pixel.id, pixel.dataset_id);
        current = pixel;kind = 'pixel';id = pixel.id;path = `${this.base(scope)}/pixels/${id}`;readback = () => this.rawPixel(scope, id);
      } else if (op.tool === 'spotify_update_capi_integration') {
        ensure(dataset.capi_integration, 'dataset has no verified CAPI integration');const capi = await this.rawCapi(scope, dataset.capi_integration.capi_connection_id);this.verifyIntegrationBinding(dataset, 'capi', capi.capi_connection_id, capi.dataset_id);
        current = capi;kind = 'capi';id = capi.capi_connection_id;path = `${this.base(scope)}/capi/${id}`;readback = () => this.rawCapi(scope, id);
      } else { current = dataset;kind = 'dataset';id = dataset.id;path = `${this.base(scope)}/datasets/${id}`;readback = () => this.rawDataset(scope, id); }
      this.expected(scope, kind, current, input.expected_configuration_hash);
    }
    const expected = { ...current, ...body };
    return { ...this.review(scope, `Update Spotify ${kind.replaceAll('_', ' ')} "${current.name}"`, 'update', body, current), execute: async () => {
      let accepted = false;
      try { await this.client.mutate(path, 'PATCH', body, z.object({}));accepted = true;const actual = await readback();ensure(digest(scope, kind, actual) === digest(scope, kind, expected), 'measurement update readback differs'); }
      catch (error) { if (!accepted && error instanceof AdportError && /HTTP (400|401|403|404|409|422)\b/.test(error.message)) throw error;return this.uncertain([id]); }
      return this.result([id]);
    } };
  }
  private async planSharing(op: WriteOperation, scope: Scope, proof?: Receipt): Promise<Plan> {
    const mobile = op.tool === 'spotify_set_mobile_app_sharing', input = mobile ? mobileSharing.parse(op.payload) : datasetSharing.parse(op.payload);
    const id = 'mobile_app_id' in input ? input.mobile_app_id : input.dataset_id, kind = mobile ? 'mobile_app' as const : 'dataset' as const;
    const current = mobile ? await this.mobile(scope, id, proof) : await this.dataset(scope, id, proof);ensure(current.shared_ad_accounts, 'native sharing dependencies are unavailable');
    this.expected(scope, kind, current, input.expected_configuration_hash);
    const shared = current.shared_ad_accounts.some(a => a.id === scope.account_id), path = `${this.base(scope)}/${mobile ? 'mobile_apps' : 'datasets'}/${id}/ad_accounts/${scope.account_id}`;
    const targetShares = [...current.shared_ad_accounts.filter(a => a.id !== scope.account_id), ...(input.shared ? [{ id: scope.account_id }] : [])], expected = { ...current, shared_ad_accounts: targetShares };
    return { ...this.review(scope, `${input.shared ? 'Share' : 'Unshare'} Spotify ${kind.replaceAll('_', ' ')} with the selected account`, 'update', { shared: input.shared }, { shared }, [...commonNotes, `Only account ${scope.account_id} changes. Other account shares are preserved. Unsharing can stop this account using the measurement source.`]), execute: async () => {
      if (shared === input.shared) return this.result([id], { changed: false, shared_with_selected_account: shared });
      const receipt = this.bind(scope, kind, id, undefined, 'sharing');let accepted = false;
      try {
        await this.client.mutate(path, input.shared ? 'POST' : 'DELETE', undefined, z.undefined());accepted = true;
        const actual = mobile ? await this.rawMobile(scope, id) : await this.rawDataset(scope, id);ensure(digest(scope, kind, actual) === digest(scope, kind, expected), 'native sharing readback differs');
      } catch (error) { if (!accepted && error instanceof AdportError && /HTTP (400|401|403|404|409|422)\b/.test(error.message)) throw error;return this.uncertain([id], receipt); }
      return this.result([id], { resource_receipt: receipt, next_tool: 'spotify_measurement_sharing_status', shared_with_selected_account: input.shared });
    } };
  }
  private async planDataset(op: WriteOperation, scope: Scope): Promise<Plan> {
    const input = createDataset.parse(op.payload), selected: Array<{ dataset: Dataset; integration_id: string; kind: 'pixel' | 'capi'; id: string }> = [];
    for (const source of input.sources) {
      const proof = this.proof(scope.account_id, source.resource_receipt), dataset = await this.dataset(scope, source.dataset_id, proof);this.exclusive(scope, dataset);this.expected(scope, 'dataset', dataset, source.expected_configuration_hash);
      if (dataset.pixel?.integration_id === source.integration_id) { const pixel = await this.rawPixel(scope, dataset.pixel.id);this.verifyIntegrationBinding(dataset, 'pixel', pixel.id, pixel.dataset_id);selected.push({ dataset, integration_id: source.integration_id, kind: 'pixel', id: pixel.id }); }
      else if (dataset.capi_integration?.integration_id === source.integration_id) { const capi = await this.rawCapi(scope, dataset.capi_integration.capi_connection_id);this.verifyIntegrationBinding(dataset, 'capi', capi.capi_connection_id, capi.dataset_id);selected.push({ dataset, integration_id: source.integration_id, kind: 'capi', id: capi.capi_connection_id }); }
      else throw new AdportError('INVALID_INPUT', 'spotify: integration is not present in its approved source dataset');
    }
    const body = { name: input.name, integration_ids: selected.map(s => s.integration_id) };
    return { ...this.review(scope, `Create Spotify dataset "${input.name}" from existing integrations`, 'create', body, undefined, [...commonNotes, 'This can reroute existing integrations and affect their measurement. Prefer creating Pixel first and adding CAPI with that dataset_id; native integration regrouping can leave inconsistent source routing, which readback must reject.', 'The new dataset is shared only with the selected ad account.']), execute: async () => {
      let id: string;
      try { id = (await this.client.mutate(`${this.base(scope)}/datasets`, 'POST', body, z.object({ id: spotifyId }))).id; }
      catch (error) { if (error instanceof AdportError && /HTTP (400|401|403|404|409|422)\b/.test(error.message)) throw error;return this.uncertain([]); }
      const receipt = this.bind(scope, 'dataset', id, id);
      try {
        ensure(!selected.some(s => s.dataset.id === id), 'dataset creation returned an existing source ID');
        const actual = await this.rawDataset(scope, id);ensure(actual.name === input.name && selected.every(s => contains(actual, s.integration_id)), 'created dataset membership mismatch');
        const previous = new Map<string, Dataset>();
        for (const source of selected) {
          if (!previous.has(source.dataset.id)) previous.set(source.dataset.id, await this.rawDataset(scope, source.dataset.id));
          ensure(!contains(previous.get(source.dataset.id)!, source.integration_id), 'native regrouping retained the integration in its source dataset');
          if (source.kind === 'pixel') { const resource = await this.rawPixel(scope, source.id);this.verifyIntegrationBinding(actual, 'pixel', resource.id, resource.dataset_id); }
          else { const resource = await this.rawCapi(scope, source.id);this.verifyIntegrationBinding(actual, 'capi', resource.capi_connection_id, resource.dataset_id); }
        }
        await this.shareCreatedDataset(scope, id);
      } catch { return this.uncertain([id], receipt); }
      return this.result([id], { resource_receipt: receipt, next_tool: 'spotify_created_measurement', dataset_id: id });
    } };
  }
  private async planRemove(op: WriteOperation, scope: Scope, proof?: Receipt): Promise<Plan> {
    const input = removeIntegration.parse(op.payload), current = await this.dataset(scope, input.dataset_id, proof);this.exclusive(scope, current);this.expected(scope, 'dataset', current, input.expected_configuration_hash);
    ensure(contains(current, input.integration_id), 'integration is not present in the selected dataset');
    return { ...this.review(scope, 'Remove Spotify dataset integration into a new native dataset', 'remove', { dataset_id: current.id, integration_id: input.integration_id }, undefined, [...commonNotes, 'Native removal creates another dataset for the integration. It does not delete the integration or stop website code. Ads using the old dataset can lose measurement.']), execute: async () => {
      let created: { id: string };
      try { created = await this.client.mutate(`${this.base(scope)}/datasets/${current.id}/integrations/${input.integration_id}`, 'DELETE', undefined, z.object({ id: spotifyId })); }
      catch (error) { if (error instanceof AdportError && /HTTP (400|401|403|404|409|422)\b/.test(error.message)) throw error;return this.uncertain([current.id]); }
      if (created.id === current.id) return this.uncertain([current.id]);
      const receipt = this.bind(scope, 'dataset', created.id, created.id);
      try {
        const next = await this.rawDataset(scope, created.id), previous = await this.rawDataset(scope, current.id);ensure(contains(next, input.integration_id) && !contains(previous, input.integration_id), 'integration removal readback is inconsistent');
        if (next.pixel?.integration_id === input.integration_id) { const resource = await this.rawPixel(scope, next.pixel.id);this.verifyIntegrationBinding(next, 'pixel', resource.id, resource.dataset_id); }
        if (next.capi_integration?.integration_id === input.integration_id) { const resource = await this.rawCapi(scope, next.capi_integration.capi_connection_id);this.verifyIntegrationBinding(next, 'capi', resource.capi_connection_id, resource.dataset_id); }
      } catch { return this.uncertain([current.id, created.id], receipt); }
      return this.result([current.id, created.id], { resource_receipt: receipt, next_tool: 'spotify_created_measurement', dataset_id: created.id });
    } };
  }

  async plan(op: WriteOperation): Promise<Plan> {
    if (op.tool === 'spotify_create_dataset') for (const source of createDataset.parse(op.payload).sources) this.proof(op.accountId, source.resource_receipt);
    const proof = this.proof(op.accountId, typeof op.payload.resource_receipt === 'string' ? op.payload.resource_receipt : undefined), scope = await this.scope(op.accountId);this.checkProof(scope, proof);
    if (op.tool === 'spotify_create_pixel' || op.tool === 'spotify_create_capi_integration' || op.tool === 'spotify_create_mobile_app') return this.planCreate(op, scope, proof);
    if (op.tool === 'spotify_create_dataset') return this.planDataset(op, scope);
    if (op.tool === 'spotify_remove_dataset_integration') return this.planRemove(op, scope, proof);
    if (op.tool === 'spotify_set_dataset_sharing' || op.tool === 'spotify_set_mobile_app_sharing') return this.planSharing(op, scope, proof);
    return this.planUpdate(op, scope, proof);
  }
}
