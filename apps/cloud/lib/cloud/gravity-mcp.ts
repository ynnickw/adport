import 'server-only';
import { Client, StreamableHTTPClientTransport, type Tool } from '@modelcontextprotocol/client';
import { AdportError } from '@adport/core';
import type { z } from 'zod';

export const GRAVITY_RESOURCE = 'https://platform.trygravity.ai/mcp';

const actions = {
  'GET info': ['advertiser_get_info', 'dashboard_get_advertiser_info'],
  'GET campaigns': ['dashboard_list_campaigns', 'advertiser_list_campaigns'],
  'GET campaigns/:campaign_id': ['dashboard_get_campaign', 'advertiser_get_campaign'],
  'GET metrics': ['dashboard_get_metrics', 'advertiser_get_metrics'],
  'GET ad-group-metrics': ['dashboard_get_ad_group_metrics', 'advertiser_get_ad_group_metrics'],
  'GET ad-unit-metrics': ['dashboard_get_ad_unit_metrics'],
  'GET ad-groups': ['dashboard_list_ad_groups'],
  'GET ad-groups/:ad_group_id': ['dashboard_get_ad_group'],
  'GET ads/:ad_id': ['dashboard_get_ad'],
  'GET pixels': ['dashboard_list_pixels'],
  'GET events/conversion-stats': ['dashboard_get_conversion_stats', 'advertiser_get_conversion_stats'],
  'GET conversions': ['dashboard_get_recent_conversions', 'advertiser_get_conversions'],
  'GET billing': ['dashboard_get_billing', 'advertiser_get_billing'],
  'POST campaigns': ['dashboard_create_campaign'],
  'POST ad-groups': ['dashboard_create_ad_group'],
  'POST ad-groups/:ad_group_id/ads': ['dashboard_create_ad'],
  'POST pixels': ['dashboard_create_pixel'],
  'PATCH campaigns/:campaign_id': ['dashboard_update_campaign'],
  'PATCH ad-groups/:ad_group_id': ['dashboard_update_ad_group'],
  'PATCH ads/:ad_id': ['dashboard_update_ad'],
} as const;

type Arguments = Record<string, unknown>;
function record(value: unknown): value is Arguments {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function route(method: string, path: string) {
  const ids: Record<string, string> = {};
  const normalized = path.replace(/^(campaigns|ad-groups|ads)\/([A-Za-z0-9_-]{1,128})(?=\/|$)/, (_, collection: string, id: string) => {
    const key = collection === 'campaigns' ? 'campaign_id' : collection === 'ads' ? 'ad_id' : 'ad_group_id';
    ids[key] = id;
    return collection + '/:' + key;
  });
  const key = method + ' ' + normalized;
  if (!Object.hasOwn(actions, key)) throw new AdportError('INVALID_INPUT', 'Unsupported Gravity advertiser operation.');
  return { names: actions[key as keyof typeof actions], ids };
}

function toolArguments(tool: Tool, ids: Arguments, fields: Arguments, mutation: boolean): Arguments | undefined {
  const properties = tool.inputSchema.properties ?? {};
  const args: Arguments = { ...ids };
  // Some dashboard actions wrap the JSON payload. Never discard approved fields to fit another signature.
  if (mutation && Object.hasOwn(properties, 'body')) args.body = fields;
  else for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    const property = properties[key];
    if (!Object.hasOwn(properties, key) && tool.inputSchema.additionalProperties !== true) return;
    const type = record(property) ? property.type : undefined;
    args[key] = (type === 'integer' || type === 'number') && typeof value === 'string' && /^\d+$/.test(value) ? Number(value)
      : type === 'boolean' && (value === 'true' || value === 'false') ? value === 'true' : value;
  }
  if (Object.keys(ids).some(k => !Object.hasOwn(properties, k) && tool.inputSchema.additionalProperties !== true)) return;
  if (tool.inputSchema.required?.some(key => !Object.hasOwn(args, key))) return;
  return args;
}

function receipt<T>(raw: unknown, schema: z.ZodType<T>, mutation: boolean): T {
  if (mutation && record(raw) && ('plan_id' in raw || 'plan' in raw || raw.requires_confirmation === true || raw.applied === false)) {
    throw new AdportError('PROVIDER_ERROR', 'Gravity returned a plan requiring its own approval. Verify the change in Gravity before retrying.');
  }
  const candidates = [raw];
  if (record(raw)) {
    for (const field of ['result', 'data', 'advertiser', 'campaign', 'ad_group', 'ad', 'pixel', 'ad_groups', 'pixels']) {
      if (Object.hasOwn(raw, field)) candidates.push(raw[field]);
    }
  }
  for (const value of candidates) {
    const parsed = schema.safeParse(value);
    if (parsed.success) return parsed.data;
  }
  throw new AdportError('PROVIDER_ERROR', 'Gravity returned an unrecognized advertiser response. Verify the result in Gravity before retrying.');
}

export class GravityMcpTransport {
  private catalog?: Promise<Tool[]>;
  constructor(private readonly accessToken: () => Promise<string>) {}

  get<T>(path: string, schema: z.ZodType<T>, params: Arguments = {}) { return this.request('GET', path, schema, params); }
  post<T>(path: string, schema: z.ZodType<T>, body: unknown) { return this.request('POST', path, schema, body); }
  patch<T>(path: string, schema: z.ZodType<T>, body: unknown) { return this.request('PATCH', path, schema, body); }

  private async discover(client: Client) {
    const tools: Tool[] = [], seen = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : {});
      tools.push(...page.tools);
      cursor = page.nextCursor;
      if (cursor && (seen.has(cursor) || seen.size >= 64)) throw new Error('Invalid Gravity tool pagination.');
      if (cursor) seen.add(cursor);
    } while (cursor);
    return tools;
  }

  private async request<T>(method: string, path: string, schema: z.ZodType<T>, fields: unknown): Promise<T> {
    if (!record(fields)) throw new AdportError('INVALID_INPUT', 'Invalid Gravity advertiser arguments.');
    const { names, ids } = route(method, path);
    const token = await this.accessToken();
    const transport = new StreamableHTTPClientTransport(new URL(GRAVITY_RESOURCE), {
      requestInit: { headers: { authorization: 'Bearer ' + token }, redirect: 'error' },
      fetch: (url, init) => fetch(url, { ...init, redirect: 'error', signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000) }),
    });
    const client = new Client({ name: 'adport', version: '1.0' });
    try {
      await client.connect(transport);
      this.catalog ??= this.discover(client).catch(error => { this.catalog = undefined; throw error; });
      const available = await this.catalog;
      for (const name of names) {
        const tool = available.find(item => item.name === name);
        if (!tool) continue;
        const args = toolArguments(tool, ids, fields, method !== 'GET');
        if (!args) continue;
        const result = await client.callTool({ name, arguments: args });
        if (!('content' in result) || !Array.isArray(result.content) || result.isError) throw new AdportError('PROVIDER_ERROR', 'Gravity declined the advertiser operation. Check the grant, permissions and any pending change in Gravity.');
        const block = result.content.length === 1 ? result.content[0] : undefined;
        const payload = result.structuredContent ?? (block?.type === 'text' ? JSON.parse(block.text) : undefined);
        return receipt(payload, schema, method !== 'GET');
      }
      throw new AdportError('PROVIDER_ERROR', 'The connected Gravity advertiser does not expose a compatible ' + names[0] + ' tool for this operation.');
    } catch (error) {
      if (error instanceof AdportError) throw error;
      throw new AdportError('PROVIDER_ERROR', 'Gravity OAuth MCP request failed. Check the connection and reconcile any pending change in Gravity.');
    } finally {
      if (transport.sessionId) await transport.terminateSession().catch(() => undefined);
      await client.close().catch(() => undefined);
    }
  }
}
