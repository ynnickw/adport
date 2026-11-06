import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { AdportError, CredentialStore, createContext, selectRuntimeCatalog, nextPageArguments, type ToolSelection, type AdportRuntime, type ProviderModule } from '@adport/core';
import { createGa4Module, createGscModule } from '@adport/provider-analytics';
import { createGtmModule } from '@adport/provider-gtm';
import { createGoogleModule } from '@adport/provider-google';
import { createMetaModule } from '@adport/provider-meta';
import { createTikTokModule } from '@adport/provider-tiktok';
import { createAppleModule } from '@adport/provider-apple';
import { createMicrosoftModule } from '@adport/provider-microsoft';
import { createRedditModule } from '@adport/provider-reddit';
import { createSnapchatModule } from '@adport/provider-snapchat';
import { createSpotifyModule } from '@adport/provider-spotify';
import { createPinterestModule } from '@adport/provider-pinterest';
import { createLinkedInModule } from '@adport/provider-linkedin';
import { createXModule } from '@adport/provider-x';
import packageJson from '../package.json';
import {
  ADPORT_UI_HTML,
  ADPORT_UI_DOMAIN,
  ADPORT_UI_RESOURCE_DOMAINS,
  ADPORT_UI_URI,
  structuredResult,
  toolInvocationLabels,
  toolTitle,
  viewForTool,
} from './ui.js';

export const PROVIDER_IDS = ['ga4', 'gsc', 'gtm', 'google', 'meta', 'tiktok', 'apple', 'microsoft', 'reddit', 'snapchat', 'spotify', 'pinterest', 'linkedin', 'x'] as const;
export { ADPORT_UI_RESOURCE_DOMAINS };
export const ADPORT_UI_RESOURCE_URIS: readonly string[] = [ADPORT_UI_URI, 'ui://adport/insight-card-v27.html', 'ui://adport/insight-card-v26.html', 'ui://adport/insight-card-v25.html', 'ui://adport/insight-card-v24.html', 'ui://adport/insight-card-v23.html', 'ui://adport/insight-card-v22.html', 'ui://adport/insight-card-v21.html', 'ui://adport/insight-card-v20.html', 'ui://adport/insight-card-v19.html', 'ui://adport/insight-card-v18.html', 'ui://adport/insight-card-v17.html', 'ui://adport/insight-card-v16.html', 'ui://adport/insight-card-v15.html', 'ui://adport/insight-card-v14.html', 'ui://adport/insight-card-v13.html', 'ui://adport/insight-card-v12.html', 'ui://adport/insight-card-v11.html', 'ui://adport/insight-card-v10.html', 'ui://adport/insight-card-v9.html', 'ui://adport/insight-card-v8.html', 'ui://adport/insight-card-v7.html', 'ui://adport/insight-card-v6.html', 'ui://adport/insight-card-v5.html', 'ui://adport/insight-card-v4.html', 'ui://adport/insight-card-v3.html', 'ui://adport/insight-card-v2.html'];

const DEFAULT_MCP_ICONS = [{
  src: 'https://app.adport.dev/icon.svg?brand=orange-dot-v2',
  mimeType: 'image/svg+xml',
  sizes: ['any'],
}];

/**
 * Standard runtime assembly: real providers whose credentials exist. Mock data
 * is opt-in so a live runtime never silently substitutes synthetic accounts.
 */
export interface AssembleRuntimeOptions {
  includeMock?: boolean;
  includeRawTools?: boolean;
}

export async function assembleRuntime(options: AssembleRuntimeOptions = {}): Promise<AdportRuntime> {
  const store = new CredentialStore();
  const modules: ProviderModule[] = [];
  const includeMock = options.includeMock ?? process.env.ADPORT_DEMO === 'true';
  if (!includeMock) {
    for (const factory of [createGa4Module, createGscModule, createGtmModule, createGoogleModule, createMetaModule, createTikTokModule, createAppleModule, createMicrosoftModule, createRedditModule, createSnapchatModule, createSpotifyModule, createPinterestModule, createLinkedInModule, createXModule]) {
      const module = await factory(store);
      if (module) modules.push(module);
    }
  }
  const runtime = await createContext({ providerModules: modules, includeMock });
  return selectRuntimeCatalog(runtime, { profile: 'full', providers: null }, options.includeRawTools ?? false);
}

export interface CreateServerOptions {
  runtime: AdportRuntime;
  catalog?: ToolSelection;
  /** Explicit local opt-in; production connectors always reject raw tools. */
  includeRawTools?: boolean;
  /** Transport-specific context, without redefining any provider tool. */
  instructions?: string;
  name?: string;
  version?: string;
  /** Brand icons advertised to MCP clients during initialization. */
  icons?: Array<{ src: string; mimeType?: string; sizes?: string[] }>;
  /** When set by a remote transport, only register tools authorized by this key. */
  scopes?: readonly string[];
  /**
   * Register tools blocked by a dynamic entitlement and return this structured
   * error when called. Missing credential scopes without a denial stay hidden.
   */
  scopeDenials?: Readonly<Record<string, ToolScopeDenial | undefined>>;
  /** Hosted transports can replace local CLI setup guidance, without changing the error code. */
  notConnectedMessage?: string;
  /** Hosted production must never serve synthetic results or demo tool definitions. */
  productionOnly?: boolean;
  /** Host-specific sandbox domain; null lets the host choose its default origin. */
  uiDomain?: string | null;
  uiResourceDomains?: readonly string[];
  /** Exact private-storage origins used by in-widget signed uploads. */
  uiConnectDomains?: readonly string[];
}

export interface ToolScopeDenial {
  code: string;
  message: string;
  data?: Record<string, unknown>;
}

type UiServerOptions = Pick<CreateServerOptions, 'name' | 'version' | 'icons' | 'uiDomain' | 'uiResourceDomains' | 'uiConnectDomains'>;

/** Static resources only. Business requests must use the normal registry server. */
export function createMcpUiServer({ name = 'adport', version = packageJson.version, icons = DEFAULT_MCP_ICONS, uiDomain = ADPORT_UI_DOMAIN, uiResourceDomains = ADPORT_UI_RESOURCE_DOMAINS, uiConnectDomains = [] }: UiServerOptions = {}): McpServer {
  const server = new McpServer({ name, version, ...(icons ? { icons } : {}) });
  registerUiResources(server, uiDomain, uiResourceDomains, uiConnectDomains);
  return server;
}

function registerUiResources(server: McpServer, uiDomain: string | null, uiResourceDomains: readonly string[], uiConnectDomains: readonly string[]): void {
  const resourceMeta = {
    ui: { ...(uiDomain ? { domain: uiDomain } : {}), prefersBorder: false, csp: { connectDomains: [...uiConnectDomains], resourceDomains: [...uiResourceDomains] } },
    ...(uiDomain?.startsWith('https://') ? { 'openai/widgetDomain': uiDomain } : {}),
  };
  for (const uri of ADPORT_UI_RESOURCE_URIS) registerAppResource(
    server,
    uri === ADPORT_UI_URI ? 'Adport insight card' : 'Adport insight card (previous URI)',
    uri,
    { description: 'Responsive Adport accounts, performance, planning estimates, creatives, recommendations, and guarded-change view.', _meta: resourceMeta },
    async () => ({ contents: [{ uri, mimeType: RESOURCE_MIME_TYPE, text: ADPORT_UI_HTML, _meta: resourceMeta }] }),
  );
}

/**
 * Thin adapter: every tool in the shared registry becomes an MCP tool.
 * No tool logic lives here — see the "one tool-definition layer" principle.
 */
export function createMcpServer({ runtime, catalog = { profile: 'full', providers: null }, includeRawTools = false, instructions, name = 'adport', version = packageJson.version, icons = DEFAULT_MCP_ICONS, scopes, scopeDenials, notConnectedMessage, productionOnly = false, uiDomain = ADPORT_UI_DOMAIN, uiResourceDomains = ADPORT_UI_RESOURCE_DOMAINS, uiConnectDomains = [] }: CreateServerOptions): McpServer {
  if (productionOnly && (runtime.dataSource === 'synthetic'
    || runtime.ctx.providers.list().some(provider => !PROVIDER_IDS.includes(provider.id as typeof PROVIDER_IDS[number]))
    || runtime.registry.list().some(tool => /^(demo|mock|synthetic)(_|$)/.test(tool.name) || /^(demo|mock|synthetic)$/.test(tool.namespace)))) {
    throw new AdportError('POLICY_VIOLATION', 'Demo tools and synthetic runtimes are not available on the production connector.');
  }
  runtime = selectRuntimeCatalog(runtime, catalog, includeRawTools && !productionOnly);
  const provenance = (value: unknown): unknown => runtime.dataSource === 'synthetic'
    ? { ...(value && typeof value === 'object' && !Array.isArray(value) ? value : { value }), data_source: 'synthetic' }
    : value;
  const server = new McpServer({ name, version, ...(icons ? { icons } : {}) }, { instructions });
  registerUiResources(server, uiDomain, uiResourceDomains, uiConnectDomains);
  for (const tool of runtime.registry.list()) {
    // Hosted directory tools must expose each operation explicitly. Keep generic
    // dispatchers in the local CLI/stdio registry, never as a hosted escape hatch.
    if (productionOnly && (tool.name === 'recommendation_apply' || /_api_(read|create|update|delete|remove)$/.test(tool.name))) continue;
    const requiredScope = tool.annotations.readOnly ? 'tools:read' : 'tools:write';
    const scopeDenial = scopes && !scopes.includes(requiredScope) ? scopeDenials?.[requiredScope] : undefined;
    if (scopes && !scopes.includes(requiredScope) && !scopeDenial) continue;
    const view = tool.presentation ?? viewForTool(tool.name, tool.annotations.readOnly ?? false);
    const labels = view ? toolInvocationLabels(view) : undefined;
    // MCP structuredContent must be an object. Preserve legacy raw arrays in
    // text/CLI results, exposing their declared schema under a value envelope.
    const wrapOutput = !!tool.output && !(tool.output instanceof z.ZodObject);
    const objectOutput = tool.output
      ? tool.output instanceof z.ZodObject ? tool.output : z.object({ value: tool.output })
      : undefined;
    const config = {
      title: toolTitle(tool.name),
      description: scopeDenial
        ? `${tool.description}\n\nUnavailable on the current plan: ${scopeDenial.message}`
        : tool.description,
      inputSchema: tool.input,
      ...(objectOutput ? { outputSchema: objectOutput.extend({
        ...(view ? { _adport: z.object({
          tool: z.literal(tool.name), view: z.literal(view), providerNames: z.record(z.string(), z.string()),
          provider: z.string().optional(), accountId: z.string().optional(),
          pagination: z.object({ cursorInput: z.string() }).optional(),
          approval: z.object({ arguments: z.record(z.string(), z.unknown()) }).optional(),
          context: z.object({ project_id: z.string() }).optional(),
          capabilities: z.object({ can_write: z.boolean() }).optional(),
          refresh: z.object({ arguments: z.record(z.string(), z.unknown()) }).optional(),
          next: z.object({ arguments: z.record(z.string(), z.unknown()) }).optional(),
        }) } : {}),
        ...(runtime.dataSource === 'synthetic' ? { data_source: z.literal('synthetic') } : {}),
      }) } : {}),
      annotations: {
        title: toolTitle(tool.name),
        readOnlyHint: tool.annotations.readOnly ?? false,
        destructiveHint: tool.annotations.destructive ?? false,
        openWorldHint: tool.annotations.openWorld ?? false,
      },
      _meta: { 'adport/catalog': tool.catalog ?? {}, ...(tool.fileInputs?.length ? { 'openai/fileParams': [...tool.fileInputs] } : {}) },
    };
    const callback = async (args: Record<string, unknown>) => {
      const descriptor = {
        ...(PROVIDER_IDS.includes(tool.namespace as typeof PROVIDER_IDS[number]) ? { provider: tool.namespace } : {}),
        ...(typeof args.account_id === 'string' ? { accountId: args.account_id } : {}),
        ...(tool.pagination ? { pagination: { cursorInput: tool.pagination.cursorInput } } : {}),
      };
      if (scopeDenial) {
        const payload = provenance({
          error: scopeDenial.code,
          code: scopeDenial.code,
          message: scopeDenial.message,
          ...scopeDenial.data,
        });
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(payload, null, 2),
          }],
          // SDK clients validate structuredContent even on isError responses.
          // Errors use JSON text (also consumed by the widget), never a fake
          // success object to satisfy the advertised output schema.
          isError: true,
          _meta: { adport: { tool: tool.name, view, ...descriptor } },
        };
      }
      try {
        const rawResult = await runtime.registry.call(tool.name, args, runtime.ctx);
        const result = provenance(rawResult);
        const structured = provenance(wrapOutput ? { value: rawResult } : rawResult);
        const rawObject = rawResult && typeof rawResult === 'object' && !Array.isArray(rawResult)
          ? rawResult as Record<string, unknown> : {};
        const nestedResult = rawObject.result && typeof rawObject.result === 'object' && !Array.isArray(rawObject.result)
          ? rawObject.result as Record<string, unknown> : {};
        const pending = rawObject.pending_operation_id ?? nestedResult.pending_operation_id;
        const privateArguments = tool.sensitiveInputs?.some(path => {
          let current: unknown = args;
          for (const key of path.split('.')) {
            if (!current || typeof current !== 'object' || !Object.hasOwn(current, key)) return false;
            current = (current as Record<string, unknown>)[key];
          }
          return current !== undefined;
        });
        const approval = view === 'operation' && typeof pending === 'string' && !args.pending_operation_id && !privateArguments
          ? { arguments: { ...args } }
          : undefined;
        const nextArgs = !privateArguments && (view === 'creatives' || view === 'records') ? nextPageArguments(tool, args, rawObject) : undefined;
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
          ...(view ? { structuredContent: structuredResult(tool.name, view, structured, approval, typeof args.project_id === 'string' ? { project_id: args.project_id } : undefined, { can_write: !scopes || scopes.includes('tools:write') }, !privateArguments && (view === 'creatives' || view === 'records') && tool.annotations.readOnly ? { arguments: Object.fromEntries(Object.entries(args).filter(([key]) => key !== 'pending_operation_id')) } : undefined, nextArgs ? { arguments: nextArgs } : undefined, descriptor) }
            : tool.output ? { structuredContent: structured as Record<string, unknown> } : {}),
        };
      } catch (err) {
        const planLimit = err instanceof AdportError && err.code === 'PLAN_LIMIT'
          && err.details && typeof err.details === 'object' && 'planLimit' in err.details
          ? err.details.planLimit : undefined;
        const payload = provenance(
          err instanceof AdportError
            ? { ...err.toJSON(), ...(planLimit ? { code: 'PLAN_LIMIT', planLimit } : {}), ...(err.code === 'NOT_CONNECTED' && notConnectedMessage && !(err.details && typeof err.details === 'object' && 'connection_recovery' in err.details) ? { message: notConnectedMessage } : {}) }
            : {
              error: 'INTERNAL',
              // Unexpected exceptions can contain credentials or private paths.
              // Do not imply that a failed response means a write was not applied.
              message: 'Adport could not complete this request. If this was a write, check its status before retrying. Contact support if the problem persists.',
            });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
          isError: true,
          _meta: { adport: { tool: tool.name, view, ...descriptor } },
        };
      }
    };
    if (view) {
      registerAppTool(server, tool.name, {
        ...config,
        _meta: {
          ...config._meta,
          ui: { resourceUri: ADPORT_UI_URI, visibility: ['model', 'app'] },
          'openai/widgetAccessible': true,
          'openai/outputTemplate': ADPORT_UI_URI,
          'openai/toolInvocation/invoking': labels!.invoking,
          'openai/toolInvocation/invoked': labels!.invoked,
        },
      }, callback);
    } else {
      server.registerTool(tool.name, config, callback);
    }
  }
  return server;
}

export async function runStdioServer(runtime: AdportRuntime, version?: string, includeRawTools = false): Promise<void> {
  serveStdio(() => createMcpServer({ runtime, version, includeRawTools }));
  // stdout is the protocol channel; stderr is for humans.
  console.error(`adport MCP server on stdio (${runtime.registry.list().length} tools, policy: ${runtime.policySource})`);
  if (runtime.ctx.providers.list().length === 0) {
    console.error('No ad providers connected. Run `adport connect <provider>` or restart with `--demo` for synthetic mock data.');
  }
}
