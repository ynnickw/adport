import { gunzipSync } from 'node:zlib';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { AdportError } from '@adport/core';
import { XAdsClient, type XParams } from './client.js';
import { xId } from './schemas.js';

export const X_PLACEMENTS = ['ALL_ON_TWITTER', 'SPOTLIGHT', 'TREND'] as const;
const scalar = z.array(z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable()).length(1).nullable().optional();
export const statsSchema = z.object({
  data_type: z.literal('stats'), time_series_length: z.literal(1),
  data: z.array(z.object({ id: xId, id_data: z.array(z.object({ segment: z.null(), metrics: z.object({
    billed_charge_local_micro: scalar, impressions: scalar, url_clicks: scalar,
  }) })).length(1) })),
  request: z.object({ params: z.object({
    start_time: z.string(), end_time: z.string(), entity: z.string(), entity_ids: z.array(xId),
    placement: z.string(), granularity: z.literal('TOTAL'), metric_groups: z.array(z.string()),
  }) }),
});
type Stats = z.infer<typeof statsSchema>;
const jobSchema = z.object({
  id_str: z.string().regex(/^\d+$/), account_id: xId, status: z.enum(['PROCESSING', 'SUCCESS', 'FAILED']), url: z.string().nullable(),
  start_time: z.string(), end_time: z.string(), entity: z.string(), entity_ids: z.array(xId), placement: z.string(),
  granularity: z.literal('TOTAL'), metric_groups: z.array(z.string()),
});
type Job = z.infer<typeof jobSchema>;
const MAX_FILE_BYTES = 20 * 1024 * 1024;

/** Report jobs are read computations, not advertising mutations. */
export class XAdsAnalytics {
  private readonly jobs = new Map<string, Job>();
  private readonly inflight = new Map<string, Promise<Stats>>();
  constructor(private readonly client: XAdsClient, private readonly fetchImpl: typeof fetch = fetch, private readonly pause: (ms: number) => Promise<unknown> = delay) {}

  async totals(accountId: string, params: XParams, asynchronous: boolean): Promise<Stats> {
    const key = JSON.stringify([accountId, Object.entries(params).sort(), asynchronous]);
    const active = this.inflight.get(key);
    if (active) return active;
    const promise = this.load(accountId, params, asynchronous, key);
    this.inflight.set(key, promise);
    try { return await promise; } finally { this.inflight.delete(key); }
  }
  private async load(accountId: string, params: XParams, asynchronous: boolean, key: string): Promise<Stats> {
    xId.parse(accountId);
    if (!asynchronous) return validateStats(await this.client.request('GET', `stats/accounts/${accountId}`, statsSchema, params), params);
    const path = `stats/jobs/accounts/${accountId}`;
    let job: Job = this.jobs.get(key) ?? (await this.client.request('POST', path, z.object({ data: jobSchema }), params)).data;
    validateJob(job, accountId, params);
    this.jobs.set(key, job);
    for (let attempt = 0; attempt <= 15; attempt++) {
      if (job.status === 'FAILED') {
        this.jobs.delete(key);
        throw new AdportError('PROVIDER_ERROR', `x: analytics job ${job.id_str} failed`);
      }
      if (job.status === 'SUCCESS') {
        if (!job.url) throw new AdportError('PROVIDER_ERROR', 'x: successful analytics job has no download URL');
        const result = validateStats(await this.download(job.url, job.id_str), params);
        this.jobs.delete(key);
        return result;
      }
      if (attempt === 15) break;
      await this.pause(1000);
      const id = job.id_str;
      const response: { data: Job[] } = await this.client.request('GET', path, z.object({ data: z.array(jobSchema) }), { job_ids: id });
      const match = response.data.filter(row => row.id_str === id);
      if (match.length !== 1 || response.data.length !== 1) throw new AdportError('PROVIDER_ERROR', 'x: analytics polling returned a different or duplicate job');
      job = match[0]!; validateJob(job, accountId, params); this.jobs.set(key, job);
    }
    // Keep the handle: the next identical request on this client resumes it.
    throw new AdportError('PROVIDER_ERROR', `x: analytics job ${job.id_str} is still processing; retry this report to resume polling`);
  }
  private async download(raw: string, id: string): Promise<Stats> {
    let url: URL;
    try { url = new URL(raw); } catch { throw new AdportError('PROVIDER_ERROR', 'x: invalid analytics download URL'); }
    if (url.origin !== 'https://ton.twimg.com' || url.username || url.password || url.hash || url.pathname !== `/advertiser-api-async-analytics/stats_job_${id}.json.gz`) {
      throw new AdportError('PROVIDER_ERROR', 'x: untrusted analytics download URL');
    }
    let response: Response;
    try { response = await this.fetchImpl(url.href, { redirect: 'error', signal: AbortSignal.timeout(30_000) }); }
    catch { throw new AdportError('PROVIDER_ERROR', 'x: analytics download transport failed'); }
    if (!response.ok || !response.body) throw new AdportError('PROVIDER_ERROR', 'x: analytics download failed');
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.byteLength;
        if (size > MAX_FILE_BYTES) { await reader.cancel(); throw new Error('size'); }
        chunks.push(value);
      }
      const compressed = Buffer.concat(chunks);
      // fetch may already decompress HTTP Content-Encoding, unlike a raw .gz file.
      const bytes = compressed[0] === 0x1f && compressed[1] === 0x8b ? gunzipSync(compressed, { maxOutputLength: MAX_FILE_BYTES }) : compressed;
      const parsed = statsSchema.safeParse(JSON.parse(bytes.toString('utf8')));
      if (!parsed.success) throw new Error('schema');
      return parsed.data;
    } catch { throw new AdportError('PROVIDER_ERROR', 'x: invalid or oversized analytics download'); }
    finally { reader.releaseLock(); }
  }
}
function matches(data: Stats['request']['params'], params: XParams): boolean {
  return Date.parse(data.start_time) === Date.parse(String(params.start_time)) && Date.parse(data.end_time) === Date.parse(String(params.end_time)) &&
    data.entity === params.entity && data.placement === params.placement && data.granularity === params.granularity &&
    [...data.entity_ids].sort().join(',') === String(params.entity_ids).split(',').sort().join(',') &&
    [...data.metric_groups].sort().join(',') === String(params.metric_groups).split(',').sort().join(',');
}
function validateJob(job: Job, accountId: string, params: XParams) {
  if (job.account_id !== accountId || !matches(job, params)) throw new AdportError('PROVIDER_ERROR', 'x: analytics job scope does not match the report');
}
function validateStats(data: Stats, params: XParams): Stats {
  const ids = String(params.entity_ids).split(','), returned = data.data.map(row => row.id);
  if (!matches(data.request.params, params) || new Set(returned).size !== returned.length || returned.some(id => !ids.includes(id)) || ids.some(id => !returned.includes(id))) {
    throw new AdportError('PROVIDER_ERROR', 'x: analytics returned incomplete, duplicate or incorrectly scoped data');
  }
  return data;
}

export function xAccountMidnight(date: string, timezone: string): number {
  z.iso.date().parse(date);
  const target = Date.parse(`${date}T00:00:00Z`);
  let format: Intl.DateTimeFormat;
  try { format = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }); }
  catch { throw new AdportError('PROVIDER_ERROR', 'x: invalid account timezone'); }
  let value = target;
  for (let i = 0; i < 5; i++) {
    const parts = Object.fromEntries(format.formatToParts(new Date(value)).map(p => [p.type, p.value]));
    const rendered = Date.parse(`${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}Z`);
    if (rendered === target) {
      if (value % 3_600_000 !== 0) throw new AdportError('INVALID_INPUT', 'x: account-local midnight is not a whole UTC hour; the API cannot represent this exact date boundary');
      return value;
    }
    value += target - rendered;
  }
  throw new AdportError('INVALID_INPUT', 'x: no midnight exists for this account-local report date');
}
