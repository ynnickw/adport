import { clearTimeout, setTimeout } from 'node:timers';
import { ADPORT_UI_RESOURCE_URIS } from '@adport/mcp';

const discoveryMethods = ['server/discover', 'tools/list', 'resources/read', 'resources/list', 'resources/templates/list', 'prompts/list'] as const;
export type McpDiscoveryMethod = typeof discoveryMethods[number];
export const isMcpDiscoveryMethod = (value: unknown): value is McpDiscoveryMethod => typeof value === 'string' && (discoveryMethods as readonly string[]).includes(value);
interface McpRequestShape { uiOnly: boolean; discoveryMethod?: McpDiscoveryMethod }

/** Bounded inspection of a clone; the SDK still validates the original envelope. */
export async function inspectMcpRequest(request: Request): Promise<McpRequestShape> {
  const ordinary = { uiOnly: false };
  if (request.method !== 'POST' || !/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') ?? '')) return ordinary;
  const declared = request.headers.get('mcp-method');
  if (declared && !isMcpDiscoveryMethod(declared)) return ordinary;
  if (Number(request.headers.get('content-length')) > 8192) return ordinary;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    reader = request.clone().body?.getReader();
    if (!reader) return ordinary;
    const deadline = new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), 100); });
    const decoder = new TextDecoder();
    let bytes = 0, text = '';
    for (;;) {
      const chunk = await Promise.race([reader.read(), deadline]);
      if (!chunk) return ordinary;
      bytes += chunk.value?.byteLength ?? 0;
      if (bytes > 8192) return ordinary;
      text += decoder.decode(chunk.value, { stream: !chunk.done });
      if (chunk.done) break;
    }
    const body: unknown = JSON.parse(text);
    if (!body || typeof body !== 'object' || Array.isArray(body) || !('jsonrpc' in body) || body.jsonrpc !== '2.0' || !('method' in body) || !isMcpDiscoveryMethod(body.method) || declared && declared !== body.method || !('id' in body) || !['number', 'string'].includes(typeof body.id)) return ordinary;
    const discoveryMethod = body.method;
    if (['resources/list', 'resources/templates/list'].includes(discoveryMethod)) return { uiOnly: true, discoveryMethod };
    const uiOnly = discoveryMethod === 'resources/read' && 'params' in body && !!body.params && typeof body.params === 'object' && 'uri' in body.params && typeof body.params.uri === 'string' && ADPORT_UI_RESOURCE_URIS.includes(body.params.uri);
    return { uiOnly, discoveryMethod };
  } catch { return ordinary; }
  finally {
    clearTimeout(timer);
    // Awaiting cancellation of a cloned stream can deadlock its original reader.
    void reader?.cancel().catch(() => {});
  }
}

export async function isMcpUiResourceRequest(request: Request): Promise<boolean> {
  return (await inspectMcpRequest(request)).uiOnly;
}
