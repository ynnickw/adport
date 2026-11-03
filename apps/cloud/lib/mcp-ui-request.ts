import { clearTimeout, setTimeout } from 'node:timers';
import { ADPORT_UI_RESOURCE_URIS } from '@adport/mcp';

/** Bounded inspection of a clone; the SDK still validates the original envelope. */
export async function isMcpUiResourceRequest(request: Request): Promise<boolean> {
  if (request.method !== 'POST' || !/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') ?? '')) return false;
  const allowed = ['resources/read', 'resources/list', 'resources/templates/list'];
  const declared = request.headers.get('mcp-method');
  if (declared && !allowed.includes(declared)) return false;
  if (Number(request.headers.get('content-length')) > 8192) return false;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    reader = request.clone().body?.getReader();
    if (!reader) return false;
    const deadline = new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), 100); });
    const decoder = new TextDecoder();
    let bytes = 0, text = '';
    for (;;) {
      const chunk = await Promise.race([reader.read(), deadline]);
      if (!chunk) return false;
      bytes += chunk.value?.byteLength ?? 0;
      if (bytes > 8192) return false;
      text += decoder.decode(chunk.value, { stream: !chunk.done });
      if (chunk.done) break;
    }
    const body: unknown = JSON.parse(text);
    if (!body || typeof body !== 'object' || Array.isArray(body) || !('jsonrpc' in body) || body.jsonrpc !== '2.0' || !('method' in body) || typeof body.method !== 'string' || !allowed.includes(body.method) || declared && declared !== body.method || !('id' in body) || !['number', 'string'].includes(typeof body.id)) return false;
    if (body.method !== 'resources/read') return true;
    return 'params' in body && !!body.params && typeof body.params === 'object' && 'uri' in body.params && typeof body.params.uri === 'string' && ADPORT_UI_RESOURCE_URIS.includes(body.params.uri);
  } catch { return false; }
  finally {
    clearTimeout(timer);
    // Awaiting cancellation of a cloned stream can deadlock its original reader.
    void reader?.cancel().catch(() => {});
  }
}
