import { createHash } from 'node:crypto';
import { AdportError, defineTool, guardedWriteTool, type AnyToolDefinition, type WriteOperation } from '@adport/core';
import { z } from 'zod';
import { MicrosoftAdsClient, type RequestScope } from './client.js';
import { MicrosoftNativeService, microsoftId as id, microsoftNativeId as nativeId, microsoftRows as rows, type MicrosoftPlan, type MicrosoftRow as Row } from './native.js';
import type { MicrosoftAdsProvider } from './provider.js';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const name = z.string().min(1).max(255).refine(value => value.trim().length > 0, 'Name cannot be blank');
const amount = z.number().positive().refine(value => Number.isSafeInteger(Math.round(value * 1_000_000)) && Math.abs(value * 1_000_000 - Math.round(value * 1_000_000)) < 0.000001, 'Amount must fit safe integer micros with at most six decimal places');
const create = z.object({ name, amount });
const selected = z.object({ budget_id: id, expected_snapshot_hash: hash });
const update = selected.extend({ name: name.optional(), amount: amount.optional() }).refine(value => value.name !== undefined || value.amount !== undefined, 'Supply a name or amount');
const assign = z.object({ campaign_id: id, budget_id: id, expected_campaign_hash: hash, expected_budget_hash: hash });
const unassign = z.object({ campaign_id: id, daily_budget: amount, expected_campaign_hash: hash });
const budgetSchema = z.object({ Id: id, Name: z.string(), Amount: z.number().positive(), BudgetType: z.string(), AssociationCount: z.number().int().nonnegative() });
const memberSchema = z.object({ Id: id, Name: z.string(), Status: z.string(), CampaignType: z.string(), SubType: z.string().nullable(), ExperimentId: id.nullable() });
const viewSchema = z.object({ budget: budgetSchema, currency: z.string().optional(), members: z.array(memberSchema), membership_complete: z.boolean(), snapshot_hash: hash });
const contextSchema = z.object({ campaign: memberSchema, budget_id: id.nullable(), effective_daily_amount: z.number().positive(), budget_type: z.string(), currency: z.string().optional(), shared_budget: viewSchema.optional(), snapshot_hash: hash });
type Budget = z.infer<typeof budgetSchema>;
type Member = z.infer<typeof memberSchema>;
type View = z.infer<typeof viewSchema>;
type Context = z.infer<typeof contextSchema>;
type Inventory = { budgets: Budget[]; campaigns: Row[]; currency?: string };
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const micros = (value: number) => { const result = Math.round(value * 1_000_000); if (!Number.isSafeInteger(result) || result <= 0) throw new AdportError('PROVIDER_ERROR', 'microsoft: native budget amount cannot be represented safely in micros'); return result; };
const sharedId = (value: unknown) => value === null || value === undefined || value === '0' || value === 0 ? null : nativeId(value);
const member = (value: Row): Member => memberSchema.parse({ Id: nativeId(value.Id), Name: value.Name, Status: value.Status, CampaignType: value.CampaignType, SubType: value.SubType ?? null, ExperimentId: sharedId(value.ExperimentId) });
const order = (a: { Id: string }, b: { Id: string }) => BigInt(a.Id) < BigInt(b.Id) ? -1 : BigInt(a.Id) > BigInt(b.Id) ? 1 : 0;
const notes = ['Snapshot checks detect changed amounts and campaign membership before sending the write. Microsoft has no atomic compare-and-set for these operations; concurrent changes can still occur.', 'Campaign status is preserved. Shared budgets are account-scoped; the amount is one daily pool, not an amount multiplied by its campaign count.'];

export const MICROSOFT_BUDGET_WRITES = new Set(['microsoft_create_shared_budget', 'microsoft_update_shared_budget', 'microsoft_delete_shared_budget', 'microsoft_assign_shared_budget', 'microsoft_unassign_shared_budget']);

/** MicrosoftDocs/Advertising@fdee2fcf, Budget and Campaign REST v13 contracts. */
export class MicrosoftBudgetService extends MicrosoftNativeService {
  constructor(client: MicrosoftAdsClient, scope: (account: string) => Promise<RequestScope>, lookupCampaign: (account: string, campaign: string) => Promise<unknown>, private readonly campaigns: (account: string) => Promise<unknown>, private readonly currency: (account: string) => Promise<string | undefined>) { super(client, scope, lookupCampaign); }

  private async inventory(account: string): Promise<Inventory> {
    const result = await this.request(account, 'Budgets/QueryByIds', { BudgetIds: null });
    const budgets = rows(result.Budgets).map(value => budgetSchema.parse({ ...value, Id: nativeId(value.Id) }));
    if (new Set(budgets.map(value => value.Id)).size !== budgets.length) throw new AdportError('PROVIDER_ERROR', 'microsoft: duplicate budget IDs in native inventory');
    budgets.forEach(value => micros(value.Amount));
    const campaigns = rows(await this.campaigns(account));
    if (new Set(campaigns.map(value => nativeId(value.Id))).size !== campaigns.length) throw new AdportError('PROVIDER_ERROR', 'microsoft: duplicate campaign IDs in native inventory');
    const currency = await this.currency(account);
    return { budgets, campaigns, ...(currency ? { currency } : {}) };
  }

  private view(account: string, budgetId: string, inventory: Inventory): View {
    const budget = inventory.budgets.find(value => value.Id === budgetId);
    if (!budget) throw new AdportError('INVALID_INPUT', 'microsoft: shared budget was not found in the selected account');
    const members = inventory.campaigns.filter(value => sharedId(value.BudgetId) === budgetId).map(member).sort(order);
    const value = { budget, ...(inventory.currency ? { currency: inventory.currency } : {}), members, membership_complete: members.length === budget.AssociationCount };
    return { ...value, snapshot_hash: digest({ account, ...value }) };
  }

  private context(account: string, campaignId: string, inventory: Inventory): Context {
    const current = inventory.campaigns.find(value => nativeId(value.Id) === campaignId);
    if (!current) throw new AdportError('INVALID_INPUT', 'microsoft: campaign was not found in the selected account');
    const campaign = member(current), budget_id = sharedId(current.BudgetId), shared_budget = budget_id ? this.view(account, budget_id, inventory) : undefined;
    // The Budget object is authoritative; a campaign's replicated DailyBudget can lag.
    const effective_daily_amount = shared_budget?.budget.Amount ?? amount.parse(current.DailyBudget);
    micros(effective_daily_amount);
    const value = { campaign, budget_id, effective_daily_amount, budget_type: z.string().parse(shared_budget?.budget.BudgetType ?? current.BudgetType), ...(inventory.currency ? { currency: inventory.currency } : {}), ...(shared_budget ? { shared_budget } : {}) };
    return { ...value, snapshot_hash: digest({ account, ...value }) };
  }

  async list(input: { account_id: string; after_budget_id?: string; limit: number }) {
    const inventory = await this.inventory(input.account_id), remaining = inventory.budgets.filter(value => !input.after_budget_id || BigInt(value.Id) > BigInt(input.after_budget_id)).sort(order), page = remaining.slice(0, input.limit), truncated = remaining.length > page.length;
    return { rows: page.map(value => this.view(input.account_id, value.Id, inventory)), truncated, ...(truncated ? { next_cursor: page.at(-1)!.Id } : {}) };
  }

  async get(account: string, budgetId: string): Promise<View> { id.parse(budgetId); return this.view(account, budgetId, await this.inventory(account)); }
  async campaignBudget(account: string, campaignId: string): Promise<Context> { id.parse(campaignId); return this.context(account, campaignId, await this.inventory(account)); }

  private complete(value: View): void {
    if (!value.membership_complete) throw new AdportError('INVALID_INPUT', 'microsoft: campaign membership does not match native AssociationCount; refresh and reconcile all campaign types before writing');
    if (value.budget.BudgetType !== 'DailyBudgetStandard') throw new AdportError('INVALID_INPUT', 'microsoft: only native DailyBudgetStandard shared budgets can be changed');
  }

  private expected(actual: string, expected: string): void {
    if (actual !== expected) throw new AdportError('INVALID_INPUT', 'microsoft: budget or campaign snapshot changed; read fresh context and request a new preview');
  }

  private eligible(value: Member): void {
    if (value.CampaignType === 'PerformanceMax' || value.SubType === 'ShoppingSmartAds' || value.ExperimentId) throw new AdportError('INVALID_INPUT', 'microsoft: Performance Max, Smart Shopping and experiment campaigns cannot be assigned or directly detached with shared-budget tools');
    if (!['Active', 'Paused', 'BudgetPaused'].includes(value.Status)) throw new AdportError('INVALID_INPUT', 'microsoft: campaign serving status is not recognized for a budget change');
  }

  private async verify(account: string, ids: string[], test: (inventory: Inventory) => boolean): Promise<string[]> {
    try { if (!test(await this.inventory(account))) throw new Error('Native readback mismatch'); }
    catch { throw new AdportError('PROVIDER_ERROR', 'microsoft: budget write was accepted but readback was not confirmed; reconcile these resource IDs before retrying', { resourceIds: ids }); }
    return ids;
  }

  async plan(op: WriteOperation): Promise<MicrosoftPlan> {
    const kinds = { microsoft_create_shared_budget: 'create', microsoft_update_shared_budget: 'update', microsoft_delete_shared_budget: 'remove', microsoft_assign_shared_budget: 'update', microsoft_unassign_shared_budget: 'update' } as const;
    if (op.provider !== 'microsoft' || !MICROSOFT_BUDGET_WRITES.has(op.tool) || op.kind !== kinds[op.tool as keyof typeof kinds]) throw new AdportError('INVALID_INPUT', 'microsoft: shared-budget operation kind mismatch');
    const input = op.tool === 'microsoft_create_shared_budget' ? create.parse(op.payload) : op.tool === 'microsoft_update_shared_budget' ? update.parse(op.payload) : op.tool === 'microsoft_delete_shared_budget' ? selected.parse(op.payload) : op.tool === 'microsoft_assign_shared_budget' ? assign.parse(op.payload) : unassign.parse(op.payload);
    const account = op.accountId, inventory = await this.inventory(account);
    const delta = (target: string, from: number, to: number) => ({ target, ...(inventory.currency ? { currency: inventory.currency } : {}), fromMicros: from === 0 ? 0 : micros(from), toMicros: micros(to) });
    const unique = (value: string, except?: string) => { if (inventory.budgets.some(budget => budget.Id !== except && budget.Name.toLowerCase() === value.toLowerCase())) throw new AdportError('INVALID_INPUT', 'microsoft: shared-budget name already exists in this account'); };
    if (op.tool === 'microsoft_create_shared_budget' && 'name' in input && 'amount' in input) {
      const value = create.parse(input); unique(value.name);
      return { summary: `Create Microsoft shared daily budget "${value.name}"`, changes: [`+ unattached shared budget ${JSON.stringify(value)}`, 'No campaigns are assigned by this operation.'], fieldChanges: [{ field: 'Name', before: '(new)', after: value.name }], notes, coercions: [], budgetDeltas: [delta(`new shared budget "${value.name}" daily pool`, 0, value.amount)], execute: async () => {
        const result = await this.request(account, 'Budgets', { Budgets: [{ Name: value.name, Amount: value.amount, BudgetType: 'DailyBudgetStandard' }] });
        const ids = Array.isArray(result.BudgetIds) ? result.BudgetIds.filter(value => value !== null).map(nativeId) : [];
        if (ids.length !== 1 || inventory.budgets.some(value => value.Id === ids[0])) throw new AdportError('PROVIDER_ERROR', 'microsoft: budget creation receipt mismatch; reconcile before retrying', { resourceIds: ids });
        return this.verify(account, ids, actual => { const view = this.view(account, ids[0]!, actual); return view.budget.Name === value.name && view.budget.Amount === value.amount && view.budget.BudgetType === 'DailyBudgetStandard' && view.membership_complete && !view.members.length; });
      } };
    }
    if (op.tool === 'microsoft_update_shared_budget' || op.tool === 'microsoft_delete_shared_budget') {
      const value = selected.parse(input), current = this.view(account, value.budget_id, inventory);
      this.complete(current); this.expected(current.snapshot_hash, value.expected_snapshot_hash);
      if (op.tool === 'microsoft_delete_shared_budget') {
        if (current.members.length) throw new AdportError('INVALID_INPUT', 'microsoft: detach all campaigns before deleting a shared budget');
        return { summary: `Delete unused Microsoft shared budget "${current.budget.Name}"`, changes: [`- shared budget ${current.budget.Id}; native AssociationCount and discovered membership are both zero`], notes, coercions: [], budgetDeltas: [], execute: async () => { await this.request(account, 'Budgets', { BudgetIds: [current.budget.Id] }, 'DELETE'); return this.verify(account, [current.budget.Id], actual => !actual.budgets.some(value => value.Id === current.budget.Id)); } };
      }
      const edit = update.parse(input); if (edit.name !== undefined) unique(edit.name, current.budget.Id);
      const fields = { ...(edit.name !== undefined && edit.name !== current.budget.Name ? { Name: edit.name } : {}), ...(edit.amount !== undefined && edit.amount !== current.budget.Amount ? { Amount: edit.amount } : {}) };
      if (!Object.keys(fields).length) throw new AdportError('INVALID_INPUT', 'microsoft: shared-budget update has no changes');
      const fieldChanges = Object.entries(fields).map(([field, after]) => ({ field, before: String(current.budget[field as keyof Budget]), after: String(after) }));
      return { summary: `Update Microsoft shared budget "${current.budget.Name}" (${current.members.length} campaign(s))`, changes: [`~ shared budget ${current.budget.Id} ${JSON.stringify(fields)}`, `Affected campaigns: ${JSON.stringify(current.members)}`], fieldChanges, notes: [...notes, `Affected campaigns: ${current.members.map(value => `${value.Id} ${value.Name} (${value.Status})`).join('; ') || '(none)'}`], coercions: [], budgetDeltas: fields.Amount !== undefined ? [delta(`shared budget ${current.budget.Id} daily pool`, current.budget.Amount, fields.Amount)] : [], execute: async () => { await this.request(account, 'Budgets', { Budgets: [{ Id: current.budget.Id, ...fields }] }, 'PUT'); return this.verify(account, [current.budget.Id], actual => { const after = this.view(account, current.budget.Id, actual); return after.membership_complete && JSON.stringify(after.members) === JSON.stringify(current.members) && Object.entries(fields).every(([key, value]) => after.budget[key as keyof Budget] === value); }); } };
    }
    if (op.tool === 'microsoft_assign_shared_budget') {
      const value = assign.parse(input), current = this.context(account, value.campaign_id, inventory), destination = this.view(account, value.budget_id, inventory);
      this.eligible(current.campaign); this.complete(destination); if (current.shared_budget) this.complete(current.shared_budget);
      this.expected(current.snapshot_hash, value.expected_campaign_hash); this.expected(destination.snapshot_hash, value.expected_budget_hash);
      if (current.budget_id === value.budget_id) throw new AdportError('INVALID_INPUT', 'microsoft: campaign already uses this shared budget');
      return { summary: `Assign Microsoft campaign "${current.campaign.Name}" to shared budget "${destination.budget.Name}"`, changes: [`~ campaign ${value.campaign_id} BudgetId ${current.budget_id ?? '(individual)'} → ${value.budget_id}`, `Source members before assignment: ${JSON.stringify(current.shared_budget?.members ?? [current.campaign])}`, `Destination members before assignment: ${JSON.stringify(destination.members)}`, 'Policy compares the campaign’s current effective daily limit with the destination pool amount. Pool membership changes can redistribute spend among its campaigns.'], fieldChanges: [{ field: 'Budget', before: current.budget_id ?? '(individual)', after: value.budget_id }], notes: [...notes, `Source campaigns: ${(current.shared_budget?.members ?? [current.campaign]).map(value => `${value.Id} ${value.Name} (${value.Status})`).join('; ')}`, `Destination campaigns: ${destination.members.map(value => `${value.Id} ${value.Name} (${value.Status})`).join('; ') || '(none)'}`], coercions: [], budgetDeltas: [delta(`campaign ${value.campaign_id} effective daily budget`, current.effective_daily_amount, destination.budget.Amount)], execute: async () => {
        await this.request(account, 'Campaigns', { AccountId: account, Campaigns: [{ Id: value.campaign_id, BudgetId: value.budget_id }] }, 'PUT');
        return this.verify(account, [value.campaign_id, value.budget_id], actual => { const after = this.context(account, value.campaign_id, actual), target = this.view(account, value.budget_id, actual); return after.budget_id === value.budget_id && after.campaign.Status === current.campaign.Status && target.membership_complete && target.budget.Amount === destination.budget.Amount && JSON.stringify(target.members) === JSON.stringify([...destination.members, current.campaign].sort(order)) && (!current.budget_id || this.view(account, current.budget_id, actual).membership_complete); });
      } };
    }
    const value = unassign.parse(input), current = this.context(account, value.campaign_id, inventory);
    this.eligible(current.campaign); this.expected(current.snapshot_hash, value.expected_campaign_hash);
    if (!current.shared_budget) throw new AdportError('INVALID_INPUT', 'microsoft: campaign is not using a shared budget');
    this.complete(current.shared_budget);
    return { summary: `Detach Microsoft campaign "${current.campaign.Name}" to its own daily budget`, changes: [`~ campaign ${value.campaign_id} BudgetId ${current.budget_id} → 0; DailyBudget → ${value.daily_budget}; BudgetType → DailyBudgetStandard`, 'The remaining shared pool amount is preserved. Detaching adds an independent daily allocation alongside that pool.'], fieldChanges: [{ field: 'Budget', before: current.budget_id!, after: '(individual DailyBudgetStandard)' }], notes, coercions: [], budgetDeltas: [delta(`campaign ${value.campaign_id} effective daily budget`, current.effective_daily_amount, value.daily_budget)], execute: async () => {
      // Clearing BudgetId starts an individual budget: native REST also requires its type (1121 if omitted).
      await this.request(account, 'Campaigns', { AccountId: account, Campaigns: [{ Id: value.campaign_id, BudgetId: '0', DailyBudget: value.daily_budget, BudgetType: 'DailyBudgetStandard' }] }, 'PUT');
      return this.verify(account, [value.campaign_id, current.budget_id!], actual => { const after = this.context(account, value.campaign_id, actual), previous = this.view(account, current.budget_id!, actual); return after.budget_id === null && after.effective_daily_amount === value.daily_budget && after.campaign.Status === current.campaign.Status && previous.membership_complete && previous.budget.Amount === current.shared_budget!.budget.Amount && JSON.stringify(previous.members) === JSON.stringify(current.shared_budget!.members.filter(value => value.Id !== current.campaign.Id)); });
    } };
  }
}

export function microsoftBudgetTools(provider: MicrosoftAdsProvider): AnyToolDefinition[] {
  return [
    defineTool({ name: 'microsoft_shared_budgets', namespace: 'microsoft', description: 'List native daily pools with all-type campaign membership, completeness and snapshot hashes. Continue next_cursor as after_budget_id.', input: z.object({ account_id: id, after_budget_id: id.optional(), limit: z.number().int().positive().max(100).default(50) }), output: z.object({ rows: z.array(viewSchema), truncated: z.boolean(), next_cursor: id.optional() }), pagination: { cursorInput: 'after_budget_id' }, annotations: { readOnly: true }, handler: input => provider.budgets.list(input) }),
    defineTool({ name: 'microsoft_get_shared_budget', namespace: 'microsoft', description: 'Read an owned daily pool, its campaign members and snapshot_hash for update, assignment or deletion. Writes reject incomplete membership.', input: z.object({ account_id: id, budget_id: id }), output: viewSchema, annotations: { readOnly: true }, handler: input => provider.budgets.get(input.account_id, input.budget_id) }),
    defineTool({ name: 'microsoft_campaign_budget', namespace: 'microsoft', description: 'Read an owned campaign’s effective daily limit, individual/shared budget, members and snapshot_hash. Use this hash as expected_campaign_hash when assigning or detaching.', input: z.object({ account_id: id, campaign_id: id }), output: contextSchema, annotations: { readOnly: true }, handler: input => provider.budgets.campaignBudget(input.account_id, input.campaign_id) }),
    guardedWriteTool({ name: 'microsoft_create_shared_budget', namespace: 'microsoft', provider: 'microsoft', kind: 'create', description: 'Create an unattached DailyBudgetStandard pool in account currency. Checks its amount in policy micros. Does not assign or activate campaigns.', payload: create }),
    guardedWriteTool({ name: 'microsoft_update_shared_budget', namespace: 'microsoft', provider: 'microsoft', kind: 'update', description: 'Rename or change one shared daily pool after binding its amount and all campaign members/statuses with expected_snapshot_hash. Monetary caps apply once to the pool; no atomic native compare-and-set.', payload: update }),
    guardedWriteTool({ name: 'microsoft_delete_shared_budget', namespace: 'microsoft', provider: 'microsoft', kind: 'remove', destructive: true, description: 'Permanently delete an owned unused shared budget. Requires matching snapshot and both native and discovered campaign counts zero; verifies disappearance.', payload: selected }),
    guardedWriteTool({ name: 'microsoft_assign_shared_budget', namespace: 'microsoft', provider: 'microsoft', kind: 'update', description: 'Assign a campaign to an owned daily pool using campaign and destination snapshot hashes. Compares current effective limit with the pool amount for policy; preserves status. Excludes Performance Max, Smart Shopping and experiments.', payload: assign }),
    guardedWriteTool({ name: 'microsoft_unassign_shared_budget', namespace: 'microsoft', provider: 'microsoft', kind: 'update', description: 'Detach to an explicit individual DailyBudgetStandard budget in account currency. Requires campaign snapshot, preserves status and remaining pool amount, and checks monetary policy. Excludes experiment campaigns.', payload: unassign }),
  ];
}
