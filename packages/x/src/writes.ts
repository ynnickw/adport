import { z } from 'zod';
import { AdportError, type WriteGuard, type WriteOperation, type WritePreview } from '@adport/core';
import type { XParams } from './client.js';
import { XAdsEntities } from './entities.js';
import { campaignSchema, createCampaignSchema, setBudgetSchema, setStatusSchema, xId } from './schemas.js';

export interface XWritePlan extends Omit<WritePreview, 'serverValidated'> { execute: () => Promise<string[]> }

/** Called by the provider on both policy preview and exact approved apply. */
export async function planXWrite(entities: XAdsEntities, op: WriteOperation, guard: WriteGuard): Promise<XWritePlan> {
  if (op.provider !== 'x') throw new AdportError('INVALID_INPUT', 'x: provider mismatch');
  const accountId = xId.parse(op.accountId), base = `accounts/${accountId}/campaigns`;
  if (op.kind === 'create' && op.tool === 'x_create_campaign') {
    const input = createCampaignSchema.parse(op.payload);
    if (input.total_budget_micros !== undefined && input.daily_budget_micros > input.total_budget_micros) throw new AdportError('INVALID_INPUT', 'x: daily budget cannot exceed total budget');
    const funding = await entities.getFundingInstrument(accountId, input.funding_instrument_id);
    if (funding.deleted || !funding.able_to_fund || funding.entity_status !== 'ACTIVE') throw new AdportError('INVALID_INPUT', 'x: selected funding instrument cannot fund a campaign');
    const status = guard.forcePausedCreation ? 'PAUSED' : input.status;
    const params: XParams = { name: input.name, funding_instrument_id: funding.id, budget_optimization: 'LINE_ITEM', entity_status: status, daily_budget_amount_local_micro: input.daily_budget_micros,
      ...(input.total_budget_micros !== undefined ? { total_budget_amount_local_micro: input.total_budget_micros } : {}) };
    return {
      summary: `Create X campaign "${input.name}"`, changes: [`+ ${JSON.stringify(params)} (${funding.currency})`, 'Campaign only; serving also requires line items, targeting and creatives.'],
      coercions: status !== input.status ? ['status coerced to PAUSED by policy (paused_creation)'] : [],
      budgetDeltas: [{ target: 'new campaign daily budget', toMicros: input.daily_budget_micros }, ...(input.total_budget_micros !== undefined ? [{ target: 'new campaign total budget', toMicros: input.total_budget_micros }] : [])],
      execute: async () => {
        const { data } = await entities.client.request('POST', base, z.object({ data: campaignSchema }), params);
        if (data.name !== input.name || data.funding_instrument_id !== funding.id || data.currency !== funding.currency || data.entity_status !== status || data.deleted || data.budget_optimization !== 'LINE_ITEM' || data.daily_budget_amount_local_micro !== input.daily_budget_micros || data.total_budget_amount_local_micro !== (input.total_budget_micros ?? null)) {
          throw new AdportError('PROVIDER_ERROR', 'x: created campaign response does not match the approved plan; inspect the account before retrying');
        }
        return [data.id];
      },
    };
  }
  if (op.kind === 'update' && ['x_set_campaign_status', 'x_set_budget'].includes(op.tool)) {
    const input = op.tool === 'x_set_budget' ? setBudgetSchema.parse(op.payload) : setStatusSchema.parse(op.payload);
    const current = await entities.getCampaign(accountId, input.campaign_id);
    if (current.deleted || current.entity_status === 'DRAFT') throw new AdportError('INVALID_INPUT', 'x: deleted and draft campaigns cannot be changed by this tool');
    let params: XParams;
    const budgetDeltas: XWritePlan['budgetDeltas'] = [];
    if ('budget_micros' in input) {
      const field = input.budget_type === 'DAILY' ? 'daily_budget_amount_local_micro' : 'total_budget_amount_local_micro';
      const from = current[field];
      if (from === null) throw new AdportError('INVALID_INPUT', 'x: no existing budget of this type; this tool does not change budget semantics');
      if (current.budget_optimization !== 'LINE_ITEM') throw new AdportError('INVALID_INPUT', 'x: unsupported campaign budget optimization');
      const daily = input.budget_type === 'DAILY' ? input.budget_micros : current.daily_budget_amount_local_micro;
      const total = input.budget_type === 'TOTAL' ? input.budget_micros : current.total_budget_amount_local_micro;
      if (daily !== null && total !== null && daily > total) throw new AdportError('INVALID_INPUT', 'x: daily budget cannot exceed total budget');
      params = { [field]: input.budget_micros };
      budgetDeltas.push({ target: `campaign ${current.id} ${input.budget_type.toLowerCase()} budget`, fromMicros: from, toMicros: input.budget_micros });
    } else params = { entity_status: input.status };
    return {
      summary: `Update X campaign "${current.name}"`, changes: Object.entries(params).map(([key, value]) => `~ ${key}: ${current[key as keyof typeof current]} → ${value}`), coercions: [], budgetDeltas,
      execute: async () => {
        const { data } = await entities.client.request('PUT', `${base}/${current.id}`, z.object({ data: campaignSchema }), params);
        const expected = { ...current, ...params };
        for (const key of ['id', 'funding_instrument_id', 'currency', 'entity_status', 'deleted', 'budget_optimization', 'daily_budget_amount_local_micro', 'total_budget_amount_local_micro'] as const) {
          if (data[key] !== expected[key]) throw new AdportError('PROVIDER_ERROR', 'x: updated campaign response does not match the approved plan; inspect the account before retrying');
        }
        return [data.id];
      },
    };
  }
  throw new AdportError('INVALID_INPUT', `x: unsupported write ${op.tool}`);
}
