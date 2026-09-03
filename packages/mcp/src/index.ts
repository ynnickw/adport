import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { AdportError, CredentialStore, createContext, type AdportRuntime, type ProviderModule } from '@adport/core';
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

export const PROVIDER_IDS = ['google', 'meta', 'tiktok', 'apple', 'microsoft', 'reddit', 'snapchat', 'spotify', 'pinterest', 'linkedin', 'x'] as const;

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
}

export async function assembleRuntime(options: AssembleRuntimeOptions = {}): Promise<AdportRuntime> {
  const store = new CredentialStore();
  const modules: ProviderModule[] = [];
  const includeMock = options.includeMock ?? process.env.ADPORT_DEMO === 'true';
  if (!includeMock) {
    for (const factory of [createGoogleModule, createMetaModule, createTikTokModule, createAppleModule, createMicrosoftModule, createRedditModule, createSnapchatModule, createSpotifyModule, createPinterestModule, createLinkedInModule, createXModule]) {
      const module = await factory(store);
      if (module) modules.push(module);
    }
  }
  return createContext({ providerModules: modules, includeMock });
}

export interface CreateServerOptions {
  runtime: AdportRuntime;
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
}

export interface ToolScopeDenial {
  code: string;
  message: string;
  data?: Record<string, unknown>;
}

/**
 * Thin adapter: every tool in the shared registry becomes an MCP tool.
 * No tool logic lives here — see the "one tool-definition layer" principle.
 */
export function createMcpServer({ runtime, name = 'adport', version = packageJson.version, icons = DEFAULT_MCP_ICONS, scopes, scopeDenials }: CreateServerOptions): McpServer {
  const server = new McpServer({ name, version, ...(icons ? { icons } : {}) });
  for (const tool of runtime.registry.list()) {
    const requiredScope = tool.annotations.readOnly ? 'tools:read' : 'tools:write';
    const scopeDenial = scopes && !scopes.includes(requiredScope) ? scopeDenials?.[requiredScope] : undefined;
    if (scopes && !scopes.includes(requiredScope) && !scopeDenial) continue;
    server.registerTool(
      tool.name,
      {
        description: scopeDenial
          ? `${tool.description}\n\nUnavailable on the current plan: ${scopeDenial.message}`
          : tool.description,
        inputSchema: tool.input.shape,
        annotations: {
          readOnlyHint: tool.annotations.readOnly ?? false,
          destructiveHint: tool.annotations.destructive ?? false,
          openWorldHint: tool.annotations.openWorld ?? false,
        },
      },
      async (args: Record<string, unknown>) => {
        if (scopeDenial) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                error: scopeDenial.code,
                code: scopeDenial.code,
                message: scopeDenial.message,
                ...scopeDenial.data,
              }, null, 2),
            }],
            isError: true,
          };
        }
        try {
          const result = await runtime.registry.call(tool.name, args, runtime.ctx);
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        } catch (err) {
          const payload =
            err instanceof AdportError
              ? err.toJSON()
              : { error: 'INTERNAL', message: err instanceof Error ? err.message : String(err) };
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
            isError: true,
          };
        }
      },
    );
  }
  return server;
}

export async function runStdioServer(runtime: AdportRuntime, version?: string): Promise<void> {
  const server = createMcpServer({ runtime, version });
  await server.connect(new StdioServerTransport());
  // stdout is the protocol channel; stderr is for humans.
  console.error(`adport MCP server on stdio (${runtime.registry.list().length} tools, policy: ${runtime.policySource})`);
  if (runtime.ctx.providers.list().length === 0) {
    console.error('No ad providers connected. Run `adport connect <provider>` or restart with `--demo` for synthetic mock data.');
  }
}
