import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { AdportError, CredentialStore, createContext, type AdportRuntime, type ProviderModule } from '@adport/core';
import { createGoogleModule } from '@adport/provider-google';
import { createMetaModule } from '@adport/provider-meta';

/**
 * Standard runtime assembly: real providers when credentials exist, the mock
 * provider otherwise (so a fresh install always has something to talk to).
 */
export async function assembleRuntime(): Promise<AdportRuntime> {
  const store = new CredentialStore();
  const modules: ProviderModule[] = [];
  for (const factory of [createGoogleModule, createMetaModule]) {
    const module = await factory(store);
    if (module) modules.push(module);
  }
  return createContext({ providerModules: modules });
}

export interface CreateServerOptions {
  runtime: AdportRuntime;
  name?: string;
  version?: string;
}

/**
 * Thin adapter: every tool in the shared registry becomes an MCP tool.
 * No tool logic lives here — see the "one tool-definition layer" principle.
 */
export function createMcpServer({ runtime, name = 'adport', version = '0.0.1' }: CreateServerOptions): McpServer {
  const server = new McpServer({ name, version });
  for (const tool of runtime.registry.list()) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.input.shape,
        annotations: {
          readOnlyHint: tool.annotations.readOnly ?? false,
          destructiveHint: tool.annotations.destructive ?? false,
        },
      },
      async (args: Record<string, unknown>) => {
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
}
