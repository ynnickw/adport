import { appendFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { fixtureResult, readCatalog } from '../../../scripts/connectors/tool-benchmark-fixture.mjs';

const [catalogPath, tracePath] = process.argv.slice(2);
const catalog = readCatalog(catalogPath);

serveStdio(() => {
  const server = new McpServer({ name: 'adport-benchmark', version: '1' }, {
    capabilities: { tools: {} }, instructions: catalog.instructions,
  });
  server.server.setRequestHandler('tools/list', async () => ({ tools: catalog.tools }));
  server.server.setRequestHandler('tools/call', async ({ params }) => {
    const args = params.arguments ?? {};
    appendFileSync(tracePath, JSON.stringify({ name: params.name, args }) + '\n');
    const result = fixtureResult(catalog, params.name, args);
    return {
      content: [{ type: 'text', text: JSON.stringify(result) }],
      ...(result.error ? { isError: true } : { structuredContent: result }),
    };
  });
  return server;
});
