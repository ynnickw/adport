import { z } from 'zod';
import { catalogInput, hash } from './catalog-schemas.js';
import { redditCatalogId } from './catalog-access.js';
import { REDDIT_CATALOG_TIMEZONES } from './catalog-feed-timezones.js';

const timezone = z.string().min(1).max(128).refine(value => REDDIT_CATALOG_TIMEZONES.has(value), 'Use a time zone from Reddit’s published IANA list');
export const sourceUrl = z.string().min(1).max(8192).refine(value => {
  try { const url = new URL(value), host = url.hostname.toLowerCase().replace(/\.$/, '');return ['https:', 'ftp:', 'sftp:'].includes(url.protocol) && !url.username && !url.password && !url.hash && !/[\x00-\x20\x7f]/.test(value) && host.includes('.') && !/[^\w.-]/.test(host) && !/^[\d.]+$/.test(host) && !['.local', '.localhost', '.internal'].some(suffix => host.endsWith(suffix)); } catch { return false; }
}, 'Use an externally hosted HTTPS, FTP or SFTP URL without embedded credentials, whitespace or a fragment');
export const feedMode = z.enum(['REPLACE', 'UPDATE']);
export const feedSchedule = z.object({
  is_paused: z.boolean(), interval: z.enum(['HOURLY', 'DAILY', 'WEEKLY', 'MONTHLY']),
  interval_count: z.number().int().positive().safe(), hour: z.number().int().min(0).max(23), minute: z.number().int().min(0).max(59),
  timezone, day_of_month: z.number().int().min(1).max(31).nullable().optional(),
  day_of_week: z.enum(['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY']).nullable().optional(),
}).strict().superRefine((input, ctx) => {
  if (input.interval === 'MONTHLY' ? input.day_of_month == null : input.day_of_month != null) ctx.addIssue({ code: 'custom', path: ['day_of_month'], message: 'Choose a day_of_month only for a monthly schedule' });
  if (input.interval === 'WEEKLY' ? input.day_of_week == null : input.day_of_week != null) ctx.addIssue({ code: 'custom', path: ['day_of_week'], message: 'Choose a day_of_week only for a weekly schedule' });
});
export const feedInput = catalogInput.extend({ feed_id: redditCatalogId }).strict();
export const feedList = catalogInput.extend({ page_size: z.number().int().min(1).max(100).default(20), cursor: z.string().min(1).max(512).optional() }).strict();
const name = z.string().min(1).max(4000).nullable(), authentication = { username: z.string().max(100).nullable().optional(), password: z.string().max(100).nullable().optional() };
const selected = feedInput.omit({ account_id: true });
export const feedCreate = catalogInput.omit({ account_id: true }).extend({
  name: name.optional(), url: sourceUrl, mode: feedMode, schedule: feedSchedule.nullable(), ...authentication,
  expected_catalog_configuration_hash: hash, acknowledge_shared_effects: z.literal(true), acknowledge_automatic_processing: z.literal(true),
}).strict();
export const feedUpdate = selected.extend({
  name: name.optional(), url: sourceUrl.optional(), mode: feedMode.optional(), schedule: feedSchedule.nullable().optional(), ...authentication,
  expected_configuration_hash: hash, acknowledge_shared_effects: z.literal(true), acknowledge_automatic_processing: z.literal(true).optional(),
}).strict().refine(input => ['name', 'url', 'mode', 'schedule', 'username', 'password'].some(key => Object.hasOwn(input, key)), 'Provide a feed field')
  .refine(input => !['url', 'mode', 'schedule', 'username', 'password'].some(key => Object.hasOwn(input, key)) || input.acknowledge_automatic_processing === true, 'Source/mode/schedule/authentication changes require automatic-processing acknowledgement');
export const feedStatus = selected.extend({ is_paused: z.boolean(), expected_configuration_hash: hash, acknowledge_shared_effects: z.literal(true), acknowledge_automatic_processing: z.literal(true) }).strict();
export const feedDelete = selected.extend({ expected_configuration_hash: hash, acknowledge_shared_effects: z.literal(true), acknowledge_delete_feed: z.literal(true) }).strict();
