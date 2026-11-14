import { z } from 'zod';

export const targetingId = z.string().regex(/^[1-9]\d*$/).max(30);
const unique = (values: string[]) => new Set(values).size === values.length;
const ids = z.array(targetingId).max(1000).refine(unique, 'Use unique IDs');
const delta = z.object({ add_ids: ids.default([]), remove_ids: ids.default([]) }).strict().refine(value => value.add_ids.length + value.remove_ids.length > 0, 'Supply additions or removals').refine(value => !value.add_ids.some(id => value.remove_ids.includes(id)), 'An ID cannot be added and removed together');
export const locationChanges = z.object({ include: delta.optional(), exclude: delta.optional() }).strict().refine(value => value.include !== undefined || value.exclude !== undefined, 'Supply included or excluded location changes');
export const targetingDevice = z.enum(['DESKTOP', 'MOBILE', 'TABLET', 'CONNECTED_TV', 'OTHER']);
export const bidMultiplier = z.number().finite().min(0.1).max(10);
export const scheduleDay = z.enum(['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY']);
const minute = z.union([z.literal(0), z.literal(15), z.literal(30), z.literal(45)]);
export const adSchedule = z.object({ day: scheduleDay, start_hour: z.number().int().min(0).max(23), start_minute: minute, end_hour: z.number().int().min(0).max(24), end_minute: minute, bid_modifier: bidMultiplier.optional() }).strict()
  .refine(value => value.end_hour !== 24 || value.end_minute === 0, '24:00 must end at minute0')
  .refine(value => value.end_hour * 60 + value.end_minute > value.start_hour * 60 + value.start_minute, 'End must follow start within the same account-local day; split overnight schedules');
export const schedules = z.array(adSchedule).max(42).superRefine((values, ctx) => {
  for (const day of scheduleDay.options) {
    const rows = values.filter(value => value.day === day).sort((a, b) => a.start_hour * 60 + a.start_minute - b.start_hour * 60 - b.start_minute);
    if (rows.length > 6) ctx.addIssue({ code: 'custom', message: 'Native maximum: six schedules per day' });
    if (rows.some((value, index) => index && value.start_hour * 60 + value.start_minute < rows[index - 1]!.end_hour * 60 + rows[index - 1]!.end_minute)) ctx.addIssue({ code: 'custom', message: 'Schedules on a day must not overlap' });
  }
});
export const targetingUpdate = z.object({
  campaign_id: targetingId, expected_snapshot_hash: z.string().regex(/^[a-f0-9]{64}$/), acknowledge_delivery_effects: z.literal(true),
  locations: locationChanges.optional(), languages: delta.optional(),
  ad_schedules: schedules.optional().describe('Replaces weekly schedule; [] removes its time restrictions. Account timezone; omitted intervals retain their existing modifier only when unchanged.'),
  device_bid_modifiers: z.array(z.object({ device: targetingDevice, bid_modifier: z.union([z.literal(0), bidMultiplier]) }).strict()).min(1).max(5).refine(values => unique(values.map(value => value.device)), 'Use unique device types').optional(),
  positive_geo_target_type: z.enum(['PRESENCE', 'PRESENCE_OR_INTEREST', 'SEARCH_INTEREST']).optional(),
  negative_geo_target_type: z.enum(['PRESENCE', 'PRESENCE_OR_INTEREST']).optional(),
}).strict().refine(value => ['locations', 'languages', 'ad_schedules', 'device_bid_modifiers', 'positive_geo_target_type', 'negative_geo_target_type'].some(key => value[key as keyof typeof value] !== undefined), 'Supply a targeting change');

export const targetingList = z.object({ account_id: z.string(), campaign_id: targetingId, page_size: z.number().int().positive().max(200).default(50), cursor: z.string().min(1).max(1024).regex(/^[A-Za-z0-9_-]+$/).optional() }).strict();
export const nativeSchedule = z.object({ dayOfWeek: scheduleDay, startHour: z.number().int().min(0).max(23), startMinute: z.enum(['ZERO', 'FIFTEEN', 'THIRTY', 'FORTY_FIVE']), endHour: z.number().int().min(0).max(24), endMinute: z.enum(['ZERO', 'FIFTEEN', 'THIRTY', 'FORTY_FIVE']) }).strict();
export const nativeTargetingCriterion = z.object({ resourceName: z.string(), criterionId: targetingId, campaign: z.string(), type: z.enum(['LOCATION', 'LANGUAGE', 'DEVICE', 'AD_SCHEDULE', 'LOCATION_GROUP', 'PROXIMITY']), status: z.enum(['ENABLED', 'PAUSED']), negative: z.boolean().default(false), bidModifier: z.number().finite().optional(), location: z.object({ geoTargetConstant: z.string().regex(/^geoTargetConstants\/[1-9]\d*$/) }).optional(), language: z.object({ languageConstant: z.string().regex(/^languageConstants\/[1-9]\d*$/) }).optional(), device: z.object({ type: z.string() }).optional(), adSchedule: nativeSchedule.optional() }).strict();
