import { z } from 'zod';
import { spotifyId } from './schemas.js';

export const pixelId = z.string().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/);
export const receiptInput = z.string().min(1).max(4096);
const hash = z.string().regex(/^[a-f0-9]{64}$/), name = z.string().trim().min(1);
export const domain = z.string().url().refine(value => { const u = new URL(value);return ['https:', 'http:'].includes(u.protocol) && !u.username && !u.password; }, 'Use an HTTP(S) URL without credentials');
export const aamField = z.enum(['EMAIL', 'PHONE', 'FIRST_NAME', 'LAST_NAME', 'DATE_OF_BIRTH', 'GENDER', 'CITY', 'STATE', 'ZIP', 'COUNTRY', 'EXTERNAL_ID']);
const datasetCreation = { dataset_id: spotifyId.optional(), expected_dataset_configuration_hash: hash.optional(), resource_receipt: receiptInput.optional() };
export const datasetTarget = { dataset_id: spotifyId, resource_receipt: receiptInput.optional() };
export const mobileTarget = { mobile_app_id: spotifyId, resource_receipt: receiptInput.optional() };
const pairing = (v: { dataset_id?: string; expected_dataset_configuration_hash?: string }) => Boolean(v.dataset_id) === Boolean(v.expected_dataset_configuration_hash);
export const createPixel = z.object({ ...datasetCreation, name, domain, aam_opt_in: z.boolean().default(false), aam_fields: z.array(aamField).max(11).default([]), acknowledge_advanced_matching: z.boolean().optional() }).strict()
  .refine(pairing, 'An existing dataset requires its current configuration hash')
  .refine(v => new Set(v.aam_fields).size === v.aam_fields.length, 'Matching fields must be unique')
  .refine(v => v.aam_opt_in ? v.acknowledge_advanced_matching === true && v.aam_fields.length > 0 : v.aam_fields.length === 0, 'Advanced matching needs explicit acknowledgement and fields; disabled matching has no fields');
export const updatePixel = z.object({ ...datasetTarget, expected_configuration_hash: hash, name: name.optional(), domain: domain.optional() }).strict().refine(v => v.name !== undefined || v.domain !== undefined, 'Provide a name or domain');
export const createCapi = z.object({ ...datasetCreation, name }).strict().refine(pairing, 'An existing dataset requires its current configuration hash');
export const updateCapi = z.object({ ...datasetTarget, expected_configuration_hash: hash, name }).strict();
export const createDataset = z.object({ name, sources: z.array(z.object({ dataset_id: spotifyId, integration_id: spotifyId, expected_configuration_hash: hash, resource_receipt: receiptInput.optional() }).strict()).min(1).max(100), acknowledge_measurement_effects: z.literal(true) }).strict().refine(v => new Set(v.sources.map(s => s.integration_id)).size === v.sources.length, 'Integration IDs must be unique');
export const updateDataset = z.object({ ...datasetTarget, expected_configuration_hash: hash, name }).strict();
export const removeIntegration = z.object({ ...datasetTarget, expected_configuration_hash: hash, integration_id: spotifyId, acknowledge_measurement_effects: z.literal(true) }).strict();
export const datasetSharing = z.object({ ...datasetTarget, expected_configuration_hash: hash, shared: z.boolean(), acknowledge_measurement_effects: z.boolean().optional() }).strict().refine(v => v.shared || v.acknowledge_measurement_effects === true, 'Unsharing requires acknowledgement of measurement effects');
const mobileFields = { name: z.string().trim().min(2).max(50), platform: z.enum(['IOS', 'ANDROID']).optional(), platform_app_id: z.string().min(2).max(120).optional(), ad_type: z.enum(['VIEW_THROUGH', 'STORE_KIT']).optional(), mobile_measurement_partner: z.enum(['KOCHAVA', 'APPS_FLYER', 'ADJUST', 'BRANCH', 'SINGULAR']).optional() };
export const createMobile = z.object(mobileFields).strict();
export const updateMobile = z.object({ ...mobileTarget, expected_configuration_hash: hash, ...mobileFields }).strict();
export const mobileSharing = z.object({ ...mobileTarget, expected_configuration_hash: hash, shared: z.boolean(), acknowledge_measurement_effects: z.boolean().optional() }).strict().refine(v => v.shared || v.acknowledge_measurement_effects === true, 'Unsharing requires acknowledgement of measurement effects');

const eventTime = z.object({ event_type: z.string().optional(), first_event_time: z.string().optional() });
export const pixelSchema = z.object({ id: pixelId, name: z.string().optional(), domain: z.string().optional(), dataset_id: spotifyId.nullable().optional(), integration_id: spotifyId.nullish(), aam_opt_in: z.boolean().optional(), aam_fields: z.array(aamField).nullish(), cookie_opt_in: z.boolean().optional(), auto_capture_opt_in: z.boolean().optional(), auto_capture_fields: z.array(z.string()).nullish(), events_received: z.array(eventTime).nullish() });
export const capiSchema = z.object({ capi_connection_id: spotifyId, name: z.string().optional(), dataset_id: spotifyId.nullable().optional(), integration_id: spotifyId.nullish(), events_received: z.array(eventTime).nullish() });
const shares = z.array(z.object({ id: spotifyId, name: z.string().optional() })).refine(v => new Set(v.map(s => s.id)).size === v.length, 'Repeated account sharing IDs');
export const datasetSchema = z.object({ id: spotifyId, name: z.string().optional(), pixel: pixelSchema.nullable().optional(), capi_integration: capiSchema.nullable().optional(), shared_ad_accounts: shares.nullish(), ad_set_count: z.number().int().nonnegative().optional(), is_archived: z.boolean().optional(), is_receiving_events: z.boolean().optional(), is_receiving_lead_events: z.boolean().optional() });
// Native MobileApp includes link_token. It is deliberately absent from this projection.
export const mobileSchema = z.object({ id: spotifyId, name: z.string(), platform: z.string().optional(), platform_app_id: z.string().optional(), ad_type: z.string().optional(), mobile_measurement_partner: z.string().optional(), dataset_id: spotifyId.nullable().optional(), integration_id: spotifyId.nullish(), ad_set_count: z.number().int().nonnegative().optional(), is_skad_network: z.boolean().optional(), shared_ad_accounts: shares.nullish() });
export const paging = z.object({ offset: z.number().int().nonnegative(), total_results: z.number().int().nonnegative(), page_size: z.number().int().nonnegative().optional() });
export const diagnosticSchema = z.object({ dataset_id: spotifyId, datasources: z.array(z.object({ datasource_type: z.enum(['PIXEL', 'CAPI', 'MOBILE_APP']), datasource_id: z.string(), granularity: z.enum(['DAILY', 'HOURLY']), timeseries: z.array(z.object({ total: z.number().optional(), timestamp: z.number().optional(), event_counts: z.array(z.object({ name: z.string(), event_count: z.number(), last_activity_ms: z.number().optional() })).optional() })) })) });
export const createdReceipt = z.object({ version: z.literal(1), purpose: z.enum(['creation', 'sharing']), account_id: spotifyId, business_id: spotifyId, kind: z.enum(['pixel', 'capi', 'mobile_app', 'dataset']), id: pixelId, dataset_id: spotifyId.optional(), issued_at: z.number().int().positive().safe(), expires_at: z.number().int().positive().safe() }).strict().refine(v => v.kind === 'pixel' || spotifyId.safeParse(v.id).success, 'Invalid resource ID');
