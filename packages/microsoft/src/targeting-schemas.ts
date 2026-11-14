import { z } from 'zod';
import { microsoftId as id, type MicrosoftRow as Row } from './native.js';

export const criterionType = z.enum(['Age', 'Gender', 'Device', 'DayTime', 'Location', 'LocationIntent', 'Radius']);
export const bidType = criterionType.exclude(['LocationIntent']);
export const adjustment = z.number().int().min(-90).max(900);
export const deviceAdjustment = z.number().int().min(-100).max(900);
export const minute = z.enum(['Zero', 'Fifteen', 'Thirty', 'FortyFive']);
export const intent = z.enum(['PeopleIn', 'PeopleInOrSearchingForOrViewingPages']);
export const target = z.discriminatedUnion('type', [
  z.object({ type: z.literal('Age'), age_range: z.enum(['EighteenToTwentyFour', 'TwentyFiveToThirtyFour', 'ThirtyFiveToFourtyNine', 'FiftyToSixtyFour', 'SixtyFiveAndAbove', 'ThirtyFiveToFiftyFour', 'FiftyFiveAndAbove', 'Unknown']), bid_adjustment_percent: adjustment.default(0) }).strict(),
  z.object({ type: z.literal('Gender'), gender: z.enum(['Male', 'Female']), bid_adjustment_percent: adjustment.default(0) }).strict(),
  z.object({ type: z.literal('Device'), device_name: z.enum(['Computers', 'Smartphones', 'Tablets']), bid_adjustment_percent: deviceAdjustment.default(0) }).strict(),
  z.object({ type: z.literal('DayTime'), day: z.enum(['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']), from_hour: z.number().int().min(0).max(23), from_minute: minute, to_hour: z.number().int().min(0).max(24), to_minute: minute, bid_adjustment_percent: adjustment.default(0) }).strict(),
  z.object({ type: z.literal('Location'), location_id: id, exclude: z.boolean().default(false), bid_adjustment_percent: adjustment.optional() }).strict(),
  z.object({ type: z.literal('LocationIntent'), intent_option: intent }).strict(),
  z.object({ type: z.literal('Radius'), latitude: z.number().min(-85).max(85), longitude: z.number().min(-180).max(180), radius: z.number().int().positive().max(800), radius_unit: z.enum(['Miles', 'Kilometers']), name: z.string().max(50).optional(), bid_adjustment_percent: adjustment.default(0) }).strict(),
]);
export const minutes = { Zero: 0, Fifteen: 15, Thirty: 30, FortyFive: 45 };
export function validateTargetBatch(value: { targets: Array<z.infer<typeof target>> }, ctx: z.RefinementCtx) {
  const devices = value.targets.filter(value => value.type === 'Device');
  if (devices.length && (devices.length !== 3 || new Set(devices.map(value => value.device_name)).size !== 3 || devices.every(value => value.bid_adjustment_percent === -100))) ctx.addIssue({ code: 'custom', message: 'Add all three distinct device types together, leaving at least one device included' });
  for (const item of value.targets) {
    if (item.type === 'Location' && item.exclude && item.bid_adjustment_percent !== undefined) ctx.addIssue({ code: 'custom', message: 'Excluded locations cannot have a bid adjustment' });
    if (item.type === 'Radius' && item.radius_unit === 'Miles' && item.radius > 500) ctx.addIssue({ code: 'custom', message: 'Radius in miles cannot exceed 500' });
    if (item.type === 'DayTime' && (item.to_hour === 24 && item.to_minute !== 'Zero' || item.from_hour * 60 + minutes[item.from_minute] >= item.to_hour * 60 + minutes[item.to_minute])) ctx.addIssue({ code: 'custom', message: 'DayTime must end after its start within one day; hour 24 requires minute Zero' });
  }
}
export const add = z.object({ campaign_id: id, targets: z.array(target).min(1).max(100) }).superRefine(validateTargetBatch);
export const reference = z.object({ campaign_id: id, criterion_id: id, criterion_type: criterionType });
// Native code2965 forbids deleting LocationIntent; restore its default through the edit tool.
export const remove = z.object({ campaign_id: id, criterion_type: criterionType.exclude(['LocationIntent']), criterion_ids: z.array(id).min(1).max(100).refine(value => new Set(value).size === value.length, 'Criterion IDs must be unique') });
export const bid = reference.extend({ criterion_type: bidType, bid_adjustment_percent: deviceAdjustment, expected_current_percent: z.number() }).superRefine((value, ctx) => {
  if (value.criterion_type !== 'Device' && value.bid_adjustment_percent < -90) ctx.addIssue({ code: 'custom', message: 'Only devices support a bid adjustment below -90 percent' });
});
export const intentUpdate = z.object({ campaign_id: id, criterion_id: id, intent_option: intent, expected_current_intent: intent });

export function nativeTarget(parent: Row, input: z.infer<typeof target>): Row {
    const criterion: Row = { Type: `${input.type}Criterion` };
    if (input.type === 'Age') criterion.AgeRange = input.age_range;
    if (input.type === 'Gender') criterion.GenderType = input.gender;
    if (input.type === 'Device') criterion.DeviceName = input.device_name;
    if (input.type === 'DayTime') Object.assign(criterion, { Day: input.day, FromHour: input.from_hour, FromMinute: input.from_minute, ToHour: input.to_hour, ToMinute: input.to_minute });
    if (input.type === 'Location') criterion.LocationId = input.location_id;
    if (input.type === 'LocationIntent') criterion.IntentOption = input.intent_option;
    // REST long values are decimal strings, including Radius (live-verified).
    if (input.type === 'Radius') Object.assign(criterion, { LatitudeDegrees: input.latitude, LongitudeDegrees: input.longitude, Radius: String(input.radius), RadiusUnit: input.radius_unit, ...(input.name !== undefined ? { Name: input.name } : {}) });
    const excluded = input.type === 'Location' && input.exclude;
    return { ...parent, Type: excluded ? `Negative${'AdGroupId' in parent ? 'AdGroup' : 'Campaign'}Criterion` : `Biddable${'AdGroupId' in parent ? 'AdGroup' : 'Campaign'}Criterion`, Criterion: criterion, ...(!excluded && input.type !== 'LocationIntent' ? { CriterionBid: { Type: 'BidMultiplier', Multiplier: input.bid_adjustment_percent ?? 0 } } : {}) };
  }
