import { z } from 'zod';

/** The source URL is an existing, narrowly scoped Storage read capability. */
export function mediaCoverSource(value: string, storageOrigin: string): URL {
  const source = new URL(value);
  const origin = new URL(storageOrigin).origin;
  const path = source.pathname.match(/^\/storage\/v1\/object\/sign\/creative-media\/([^/]+)\/([^/]+)$/);
  const localHttp = source.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(source.hostname);
  if ((source.protocol !== 'https:' && !localHttp) || source.origin !== origin || source.username || source.password || source.hash || !path
    || !z.string().uuid().safeParse(path[1]).success || !z.string().uuid().safeParse(path[2]).success
    || source.searchParams.size !== 1 || !source.searchParams.get('token') || source.searchParams.get('token')!.length > 8192) {
    throw new Error('Invalid private media preview');
  }
  return source;
}

export function mediaCoverUrl(source: string, cloudOrigin: string, storageOrigin: string): string {
  const valid = mediaCoverSource(source, storageOrigin);
  const cover = new URL('/api/media/cover', cloudOrigin);
  cover.searchParams.set('source', valid.href);
  return cover.href;
}
