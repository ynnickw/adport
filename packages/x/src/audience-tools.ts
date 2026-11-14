import { defineTool, guardedWriteTool, type AnyToolDefinition } from '@adport/core';
import { z } from 'zod';
import type { XAdsProvider } from './provider.js';
import { xId as id } from './schemas.js';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const name = z.string().trim().min(1).max(255);
const ids = z.array(id).min(1).max(200).refine(values => new Set(values).size === values.length, 'Use unique IDs');
const page = { cursor: z.string().min(1).max(4096).optional(), count: z.number().int().min(1).max(1000).default(200), with_total_count: z.boolean().default(false).describe('Request a total on the initial page; cursor requests omit this native flag') };
export const audienceList = z.object({ account_id: id, ...page, permission_scope: z.enum(['OWNER', 'SHARED']).default('OWNER'), custom_audience_ids: ids.optional(), q: z.string().min(1).max(255).optional(), with_deleted: z.boolean().default(false) }).strict();
export const audienceGet = z.object({ account_id: id, custom_audience_id: id, with_deleted: z.boolean().default(false) }).strict();
export const audiencePermissions = z.object({ account_id: id, custom_audience_id: id, ...page, granted_account_ids: ids.optional(), custom_audience_permission_ids: ids.optional() }).strict();
export const createAudience = z.object({ name, description: z.string().max(4096).optional() }).strict();
export const updateAudience = z.object({ custom_audience_id: id, expected_configuration_hash: hash, name: name.optional(), description: z.string().max(4096).optional() }).strict().refine(value => value.name !== undefined || value.description !== undefined, 'Provide a name or description');
export const deleteAudience = z.object({ custom_audience_id: id, expected_configuration_hash: hash, expected_usage_hash: hash }).strict();
const values = z.array(hash).min(1).max(100).refine(value => new Set(value).size === value.length, 'Identifiers must be unique within a user field');
const user = z.object({ email: values.optional(), device_id: values.optional(), handle: values.optional(), twitter_id: values.optional(), phone_number: values.optional(), partner_user_id: z.array(z.string().min(1).max(1024)).min(1).max(100).optional() }).strict().refine(value => Object.keys(value).length > 0, 'Each user needs an identifier');
const operation = z.object({ operation_type: z.enum(['Update', 'Delete']), params: z.object({ users: z.array(user).min(1).max(2500), effective_at: z.iso.datetime().optional(), expires_at: z.iso.datetime().optional() }).strict().refine(value => !value.expires_at || !value.effective_at || Date.parse(value.expires_at) > Date.parse(value.effective_at), 'Expiry must follow the effective time') }).strict();
export const audienceUsers = z.object({ custom_audience_id: id, expected_configuration_hash: hash, operations: z.array(operation).min(1).max(2500) }).strict()
  .refine(value => value.operations.reduce((total, op) => total + op.params.users.length, 0) <= 2500, 'Adport limit: 2500 total user records per approved call')
  .refine(value => Buffer.byteLength(JSON.stringify(value.operations)) <= 5_000_000, 'Native JSON body must not exceed 5000000 bytes');

export function xAudienceTools(provider: XAdsProvider): AnyToolDefinition[] {
  const output = z.looseObject({ records: z.array(z.record(z.string(), z.unknown())) });
  const read = { namespace: 'x', presentation: 'records' as const, output, annotations: { readOnly: true } };
  const write = { namespace: 'x', provider: 'x' };
  return [
    defineTool({ ...read, name: 'x_custom_audiences', description: 'List owned or already shared X custom audiences with exact native cursor filters, targetability and configuration hashes. Load more retains selection; no members are returned.', input: audienceList, pagination: { cursorInput: 'cursor' }, handler: input => provider.audiences.list(input) }),
    defineTool({ ...read, name: 'x_get_custom_audience', description: 'Read one selected-account custom audience, ownership and configuration_hash. Processing/size/targetability are native diagnostics, not proof of exact member contents.', input: audienceGet, handler: input => provider.audiences.get(input) }),
    defineTool({ ...read, name: 'x_custom_audience_permissions', description: 'Inspect existing audience sharing permissions with native cursor/ID filters; does not grant, revoke or expand access.', input: audiencePermissions, pagination: { cursorInput: 'cursor' }, handler: input => provider.audiences.permissions(input) }),
    defineTool({ ...read, name: 'x_custom_audience_usage', description: 'Inspect all targeted campaigns, including inactive groups, sharing permissions and direct audience inclusion/exclusion criteria. Bounded complete scan supplies usage_hash for deletion; incomplete scans fail.', input: z.object({ account_id: id, custom_audience_id: id }).strict(), handler: input => provider.audiences.usage(input.account_id, input.custom_audience_id) }),
    guardedWriteTool({ ...write, name: 'x_create_custom_audience', kind: 'create', destructive: false, description: 'Create an empty owned CRM audience placeholder. Independently reads back ownership and approved metadata; no user upload, ad association, sharing or activation.', payload: createAudience }),
    guardedWriteTool({ ...write, name: 'x_update_custom_audience', kind: 'update', destructive: false, description: 'Edit an owned audience name or description using a fresh configuration_hash. Preserves omitted metadata and audience type; independently verifies native readback.', payload: updateAudience }),
    guardedWriteTool({ ...write, name: 'x_update_custom_audience_users', kind: 'update', destructive: true, description: 'Submit explicit Update/Delete member groups to an owned CRM audience. Identifiers must already be normalized SHA256, except native partner_user_id. Preview shows counts/digest; receipt confirms processing acceptance, not targeting readiness. No automatic retry.', payload: audienceUsers, sensitiveInputs: ['operations'] }),
    guardedWriteTool({ ...write, name: 'x_delete_custom_audience', kind: 'remove', destructive: true, description: 'Delete an owned unreferenced, unshared audience using current configuration and usage hashes. Checks inactive targeting and exclusions, then independently verifies deleted=true. No restore endpoint is claimed.', payload: deleteAudience }),
  ];
}
