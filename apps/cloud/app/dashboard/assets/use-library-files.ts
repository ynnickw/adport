'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { MediaAsset } from '@adport/core';
import { responseJson } from './media-client';
import { LIBRARY_PAGE_SIZE } from './library-constants';

type Filters = { query: string; kind: string; tag: string };
type Page = { assets: MediaAsset[]; truncated: boolean; next_cursor?: string };
const filterKey = (filters: Filters) => JSON.stringify(filters);
const matches = (asset: MediaAsset, filters: Filters) => (!filters.query || asset.name.toLowerCase().includes(filters.query.toLowerCase()))
  && (!filters.kind || (filters.kind === 'document' ? ['application/pdf', 'text/csv'].includes(asset.content_type) : asset.content_type.startsWith(`${filters.kind}/`)))
  && (!filters.tag || asset.tags?.includes(filters.tag));

export function useLibraryFiles(projectId: string, initial: Page, filters: Filters) {
  const [page, setPage] = useState(initial), [loading, setLoading] = useState(false), [loadingMore, setLoadingMore] = useState(false), [error, setError] = useState('');
  const cache = useRef(new Map<string, Page>([[filterKey({ query: '', kind: '', tag: '' }), initial]]));
  const confirmed = useRef(new Map<string, MediaAsset>()), removed = useRef(new Set<string>());
  const current = useRef({ filters, page }); current.current = { filters, page };
  const generation = useRef(0), request = useRef<AbortController | null>(null), moreLock = useRef(false), shownKey = useRef(filterKey({ query: '', kind: '', tag: '' }));
  const key = filterKey(filters);
  const remember = useCallback((key: string, value: Page) => {
    cache.current.delete(key); cache.current.set(key, value);
    if (cache.current.size > 8) cache.current.delete(cache.current.keys().next().value!);
  }, []);
  const load = useCallback(async (selected: Filters, cursor: string | undefined, signal: AbortSignal): Promise<Page> => {
    const params = new URLSearchParams({ project_id: projectId, limit: String(LIBRARY_PAGE_SIZE) });
    if (selected.query) params.set('query', selected.query); if (selected.kind) params.set('kind', selected.kind); if (selected.tag) params.set('tag', selected.tag); if (cursor) params.set('cursor', cursor);
    const result = await responseJson<Page>(await fetch(`/api/media?${params}`, { cache: 'no-store', signal }));
    return { ...result, assets: result.assets.map(asset => {
      const local = confirmed.current.get(asset.id);
      return local && local.sha256 === asset.sha256 && (local.metadata_version ?? 0) > (asset.metadata_version ?? 0) ? { ...asset, ...local, preview_url: asset.preview_url ?? local.preview_url } : asset;
    }).filter(asset => !removed.current.has(asset.id) && matches(asset, selected)) };
  }, [projectId]);
  useEffect(() => {
    const selected = JSON.parse(key) as Filters, version = ++generation.current;
    request.current?.abort(); moreLock.current = false; setLoadingMore(false); setError('');
    const cached = cache.current.get(key);
    if (cached) { shownKey.current = key; setPage(cached); setLoading(false); return; }
    const controller = new AbortController(); request.current = controller;
    const timer = setTimeout(() => {
      setLoading(true);
      void load(selected, undefined, controller.signal).then(result => {
        if (version !== generation.current) return; shownKey.current = key; remember(key, result); setPage(result);
      }).catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'Files could not be loaded.'); })
        .finally(() => { if (version === generation.current) setLoading(false); });
    }, selected.query ? 220 : 0);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [key, load, remember]);
  useEffect(() => () => { generation.current++; request.current?.abort(); }, []);

  const more = useCallback(async () => {
    const { filters: selected, page: shown } = current.current;
    if (!shown.next_cursor || moreLock.current || loading || shownKey.current !== filterKey(selected)) return;
    moreLock.current = true; setLoadingMore(true); setError('');
    const version = generation.current, selectedKey = filterKey(selected), controller = new AbortController(); request.current = controller;
    try {
      const result = await load(selected, shown.next_cursor, controller.signal);
      if (version !== generation.current) return;
      const latest = cache.current.get(selectedKey) ?? shown, ids = new Set(latest.assets.map(asset => asset.id));
      const next = { ...result, assets: [...latest.assets, ...result.assets.filter(asset => !ids.has(asset.id))] };
      if (result.truncated && result.next_cursor === shown.next_cursor) throw new Error('The next page did not advance. Refresh the library.');
      remember(selectedKey, next); setPage(next);
    } catch (reason) { if (!controller.signal.aborted && version === generation.current) setError(reason instanceof Error ? reason.message : 'More files could not be loaded.'); }
    finally { if (version === generation.current) { moreLock.current = false; setLoadingMore(false); } }
  }, [load, loading, remember]);

  const refresh = useCallback(async () => {
    const { filters: selected, page: shown } = current.current, version = ++generation.current;
    request.current?.abort(); const controller = new AbortController(); request.current = controller;
    moreLock.current = false; setLoadingMore(false); setLoading(true); setError('');
    try {
      const collected: MediaAsset[] = [], seen = new Set<string>(), ids = new Set<string>(); let result: Page, cursor: string | undefined;
      do {
        result = await load(selected, cursor, controller.signal); for (const asset of result.assets) { if (!ids.has(asset.id)) { ids.add(asset.id); collected.push(asset); } }
        cursor = result.truncated ? result.next_cursor : undefined;
        if (cursor && seen.has(cursor)) throw new Error('The library page did not advance.'); if (cursor) seen.add(cursor);
      } while (cursor && collected.length < Math.max(LIBRARY_PAGE_SIZE, shown.assets.length));
      if (version !== generation.current) return;
      // Metadata and new files refresh without discarding the pages already loaded.
      const next = { ...result!, assets: collected }; cache.current.clear(); remember(filterKey(selected), next); setPage(next);
    } catch (reason) { if (!controller.signal.aborted && version === generation.current) setError(reason instanceof Error ? reason.message : 'Files could not be refreshed.'); }
    finally { if (version === generation.current) setLoading(false); }
  }, [load, remember]);

  const update = useCallback((asset: MediaAsset, insert = false) => {
    if (removed.current.has(asset.id) || (confirmed.current.get(asset.id)?.metadata_version ?? 0) > (asset.metadata_version ?? 0)) return;
    confirmed.current.set(asset.id, asset);
    for (const [cachedKey, cached] of cache.current) {
      const selected = JSON.parse(cachedKey) as Filters, exists = cached.assets.some(value => value.id === asset.id);
      if (!exists && !insert && selected.tag && matches(asset, selected)) { cache.current.delete(cachedKey); continue; }
      const assets = matches(asset, selected) ? exists ? cached.assets.map(value => value.id === asset.id ? { ...value, ...asset, preview_url: asset.preview_url ?? value.preview_url } : value) : insert ? [asset, ...cached.assets] : cached.assets : cached.assets.filter(value => value.id !== asset.id);
      cache.current.set(cachedKey, { ...cached, assets });
    }
    const active = cache.current.get(filterKey(current.current.filters)); if (active) setPage(active);
  }, []);
  const remove = useCallback((ids: string[]) => {
    for (const id of ids) removed.current.add(id);
    for (const [key, cached] of cache.current) cache.current.set(key, { ...cached, assets: cached.assets.filter(asset => !removed.current.has(asset.id)) });
    const active = cache.current.get(filterKey(current.current.filters)); if (active) setPage(active);
  }, []);
  return { ...page, loading: loading || shownKey.current !== key, loadingMore, error, refresh, more, update, remove };
}
