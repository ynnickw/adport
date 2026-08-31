import { z } from 'zod';
import { AdportError, type Account } from '@adport/core';
import { XAdsClient } from './client.js';
import { accountSchema, campaignSchema, fundingSchema, lineItemSchema, mediaCreativeSchema, promotedAccountSchema, promotedTweetSchema, xId } from './schemas.js';

export class XAdsEntities {
  constructor(readonly client: XAdsClient) {}
  async listAccounts(): Promise<Account[]> {
    // X's account response has no currency. It belongs to funding instruments
    // and campaigns; never infer USD or invent account currency here.
    return (await this.client.list('accounts', accountSchema)).map(a => ({ provider: 'x', id: a.id, name: a.name, status: a.approval_status }));
  }
  async getAccount(accountId: string) {
    const { data } = await this.client.request('GET', `accounts/${xId.parse(accountId)}`, z.object({ data: accountSchema }));
    if (data.id !== accountId) throw new AdportError('PROVIDER_ERROR', 'x: account ID mismatch');
    return data;
  }
  listCampaigns(accountId: string) {
    return this.client.list(`accounts/${xId.parse(accountId)}/campaigns`, campaignSchema, { with_deleted: true, with_draft: true });
  }
  async getCampaign(accountId: string, campaignId: string) {
    const { data } = await this.client.request('GET', `accounts/${xId.parse(accountId)}/campaigns/${xId.parse(campaignId)}`, z.object({ data: campaignSchema }));
    if (data.id !== campaignId) throw new AdportError('PROVIDER_ERROR', 'x: campaign ID mismatch');
    return data;
  }
  async listFundingInstruments(accountId: string) {
    const data = await this.client.list(`accounts/${xId.parse(accountId)}/funding_instruments`, fundingSchema);
    if (data.some(f => f.account_id !== accountId)) throw new AdportError('PROVIDER_ERROR', 'x: funding instrument account mismatch');
    return data;
  }
  async getFundingInstrument(accountId: string, fundingId: string) {
    const { data } = await this.client.request('GET', `accounts/${xId.parse(accountId)}/funding_instruments/${xId.parse(fundingId)}`, z.object({ data: fundingSchema }));
    if (data.id !== fundingId || data.account_id !== accountId) throw new AdportError('PROVIDER_ERROR', 'x: funding instrument account/ID mismatch');
    return data;
  }
  listLineItems(accountId: string) {
    return this.client.list(`accounts/${xId.parse(accountId)}/line_items`, lineItemSchema, { with_deleted: true, with_draft: true });
  }
  listPromotedTweets(accountId: string) {
    return this.client.list(`accounts/${xId.parse(accountId)}/promoted_tweets`, promotedTweetSchema, { with_deleted: true });
  }
  listPromotedAccounts(accountId: string) {
    return this.client.list(`accounts/${xId.parse(accountId)}/promoted_accounts`, promotedAccountSchema, { with_deleted: true });
  }
  listMediaCreatives(accountId: string) {
    return this.client.list(`accounts/${xId.parse(accountId)}/media_creatives`, mediaCreativeSchema, { with_deleted: true });
  }
}
