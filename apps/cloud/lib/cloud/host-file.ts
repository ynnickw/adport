import 'server-only';
import { createHash } from 'node:crypto';
import { AdportError, hostFileSchema, MAX_PROJECT_MEDIA_BYTES, PROJECT_MEDIA_TYPES, verifyMedia, type HostFile } from '@adport/core';

/** ChatGPT fileParams contract reviewed against OpenAI's reference 2026-11-04. */
export async function readHostFile(input: HostFile, fetchImpl: typeof fetch = fetch) {
  const file = hostFileSchema.parse(input);
  let target: URL;
  try { target = new URL(file.download_url); }
  catch { throw new AdportError('INVALID_INPUT', 'A valid host attachment download URL is required.'); }
  // This is a file-capability reader, not a general URL fetcher or API proxy.
  if (target.protocol !== 'https:' || target.hostname !== 'files.oaiusercontent.com' || target.port || target.username || target.password || target.hash) throw new AdportError('INVALID_INPUT', 'Only HTTPS files.oaiusercontent.com attachment URLs without credentials, ports or fragments are supported.');
  let response: Response;
  try { response = await fetchImpl(target.href, { method: 'GET', redirect: 'error', cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(60_000) }); }
  catch { throw new AdportError('PROVIDER_ERROR', 'The host attachment download was not available. Refresh the file reference; no project import was started.'); }
  if (response.status !== 200 || response.redirected || !response.body) {
    await response.body?.cancel();
    throw new AdportError('PROVIDER_ERROR', 'The host attachment was not returned as a direct successful download. Refresh the file reference.');
  }
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) <= 0 || Number(length) > MAX_PROJECT_MEDIA_BYTES)) {
    await response.body.cancel();
    throw new AdportError('INVALID_INPUT', 'The host attachment is empty or exceeds the 50 MiB project limit.');
  }
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_PROJECT_MEDIA_BYTES) { await reader.cancel(); throw new AdportError('INVALID_INPUT', 'The host attachment exceeds the 50 MiB project limit.'); }
      chunks.push(part.value);
    }
  } catch (error) {
    if (error instanceof AdportError) throw error;
    throw new AdportError('PROVIDER_ERROR', 'The host attachment download was interrupted. No project import was started.');
  } finally { reader.releaseLock(); }
  if (length !== null && size !== Number(length)) throw new AdportError('PROVIDER_ERROR', 'The host attachment download was incomplete.');
  const bytes = Buffer.concat(chunks, size), name = (file.file_name?.trim() || 'attachment').replace(/[\\/\x00-\x1f\x7f]/g, '_');
  return verifyMedia(bytes, name, createHash('sha256').update(bytes).digest('hex'), { maxBytes: MAX_PROJECT_MEDIA_BYTES, contentTypes: PROJECT_MEDIA_TYPES, contentType: file.mime_type });
}
