import type { MediaAsset } from '@adport/core';

export type MediaPlatform = NonNullable<MediaAsset['platforms']>[number];

export async function responseJson<T>(response: Response): Promise<T> {
  const value = await response.json();
  if (!response.ok) throw new Error(typeof value.error === 'string' ? value.error : 'This library action could not be completed.');
  return value as T;
}
export async function mediaAction<T>(projectId: string, tool: string, args: Record<string, unknown>): Promise<T> {
  return responseJson<T>(await fetch(`/api/media/actions?project_id=${encodeURIComponent(projectId)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tool, arguments: args }), signal: AbortSignal.timeout(180_000) }));
}
export type Preview = { status: string; pending_operation_id: string; preview: { summary: string; changes: string[]; notes?: string[]; coercions?: string[] }; result?: { resourceIds?: string[]; details?: { asset?: MediaAsset } } };
export async function applyLibraryChange(projectId: string, tool: string, args: Record<string, unknown>) {
  const preview = await mediaAction<Preview>(projectId, tool, args);
  if (preview.status !== 'pending_validation' || !preview.pending_operation_id) throw new Error('The library change was not prepared. Refresh before trying again.');
  return mediaAction<Preview>(projectId, tool, { ...args, pending_operation_id: preview.pending_operation_id });
}
const extensions: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', heic: 'image/heic', gif: 'image/gif', mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', pdf: 'application/pdf' };
export function fileContentType(file: Pick<File, 'type' | 'name'>) {
  if (['audio/x-wav', 'audio/vnd.wave', 'audio/wave'].includes(file.type)) return 'audio/wav';
  return file.type && file.type !== 'application/octet-stream' ? file.type : extensions[file.name.split('.').at(-1)?.toLowerCase() ?? ''] ?? '';
}
export async function uploadProjectFile(input: { projectId: string; storageOrigin: string; file: File; maxBytes: number; acceptedTypes: string[]; progress: (state: string, percent?: number, mediaId?: string) => void; ready?: (asset: MediaAsset) => void }) {
  const { file, progress, projectId } = input, contentType = fileContentType(file), endpoint = `/api/media?project_id=${encodeURIComponent(projectId)}`;
  if (!file.size || file.size > input.maxBytes || !input.acceptedTypes.includes(contentType)) throw new Error(`Choose a supported file up to ${Math.floor(input.maxBytes / 1024 / 1024)} MB.`);
  progress('Checking');
  const bytes = await file.arrayBuffer(), digest = await crypto.subtle.digest('SHA-256', bytes);
  const sha256 = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  const prepared = await responseJson<{ media_id: string; upload_url: string }>(await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: file.name, byte_length: file.size, content_type: contentType, sha256 }), signal: AbortSignal.timeout(60_000) }));
  const destination = new URL(prepared.upload_url);
  if (destination.origin !== input.storageOrigin || destination.username || destination.password || destination.hash || destination.pathname !== `/storage/v1/object/upload/sign/creative-media/${projectId}/${prepared.media_id}`) throw new Error('The private upload destination could not be verified.');
  progress('Uploading', 0, prepared.media_id);
  await new Promise<void>((resolve, reject) => {
    const request = new XMLHttpRequest(); request.open('PUT', destination.href); request.timeout = 300_000;
    request.setRequestHeader('content-type', contentType); request.setRequestHeader('x-upsert', 'false'); request.setRequestHeader('cache-control', 'max-age=0');
    request.upload.onprogress = event => { if (event.lengthComputable) progress('Uploading', Math.round(event.loaded / event.total * 100), prepared.media_id); };
    request.onload = () => request.status >= 200 && request.status < 300 ? resolve() : reject(new Error('Upload was not confirmed. Verify this upload before sending the file again.'));
    request.onerror = request.ontimeout = request.onabort = () => reject(new Error('Upload was interrupted. Verify this upload before sending the file again.'));
    request.send(bytes);
  });
  progress('Verifying', 100, prepared.media_id);
  const finalized = await responseJson<{ asset: MediaAsset }>(await fetch(endpoint, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ media_id: prepared.media_id }), signal: AbortSignal.timeout(120_000) }));
  if (finalized.asset?.id !== prepared.media_id || finalized.asset.sha256 !== sha256 || finalized.asset.byte_length !== file.size || finalized.asset.content_type !== contentType || finalized.asset.status !== 'READY') throw new Error('The file was not confirmed as ready. Verify this upload before sending it again.');
  input.ready?.(finalized.asset);
  return prepared.media_id;
}

export const formatBytes = (size: number) => size >= 1024 * 1024 ? `${(size / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.ceil(size / 1024))} KB`;
