import { afterEach, describe, expect, it, vi } from 'vitest';
import { RedditAdsClient } from '../src/client.js';

const credentials = { clientId: 'client', clientSecret: 'receipt-secret', refreshToken: 'refresh', userAgent: 'desktop:adport.test:v0.7 (by /u/adporttest)' };
const client = () => new RedditAdsClient(credentials, async () => { throw new Error('No network access for resource receipt checks'); });
afterEach(() => vi.useRealTimers());

describe('account-bound Reddit async resource receipts', () => {
  it('binds a native job ID to account, profile and kind without contacting the provider', () => {
    const c = client(), receipt = c.resourceReceipt('post_job', 'account', 'profile', 'job');
    expect(c.verifyResourceReceipt(receipt, 'post_job', 'account', 'job')).toEqual({ profile_id: 'profile' });
    expect(receipt).not.toContain(credentials.clientSecret);
    expect(() => c.verifyResourceReceipt(receipt, 'post_job', 'foreign', 'job')).toThrow('invalid or expired');
    expect(() => c.verifyResourceReceipt(receipt, 'post_job', 'account', 'foreign')).toThrow('invalid or expired');
    expect(() => c.verifyResourceReceipt(receipt, 'asset_upload', 'account', 'job')).toThrow('invalid or expired');
  });
  it('rejects tampering, another app key and malformed identifiers', () => {
    const c = client(), receipt = c.resourceReceipt('asset_upload', 'account', 'profile', 'upload');
    const [body, signature] = receipt.split('.'), changed = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body!, 'base64url').toString()), account_id: 'foreign' })).toString('base64url');
    expect(() => c.verifyResourceReceipt(`${changed}.${signature}`, 'asset_upload', 'foreign', 'upload')).toThrow('invalid or expired');
    const another = new RedditAdsClient({ ...credentials, clientSecret: 'another-app' });
    expect(() => another.verifyResourceReceipt(receipt, 'asset_upload', 'account', 'upload')).toThrow('invalid or expired');
    expect(() => c.resourceReceipt('post_job', 'account', '../profile', 'job')).toThrow('invalid resource ID');
  });
  it('expires after24hours while preserving receipts across access-token refreshes and processes', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-03T00:00:00Z'));
    const receipt = client().resourceReceipt('post_job', 'account', 'profile', 'job');
    vi.setSystemTime(new Date('2026-11-03T23:59:00Z'));
    const restarted = new RedditAdsClient({ ...credentials, refreshToken: 'rotated-refresh' });
    expect(restarted.verifyResourceReceipt(receipt, 'post_job', 'account', 'job')).toEqual({ profile_id: 'profile' });
    vi.setSystemTime(new Date('2026-11-04T00:00:00Z'));
    expect(() => restarted.verifyResourceReceipt(receipt, 'post_job', 'account', 'job')).toThrow('invalid or expired');
  });
  it('rejects alternate base64url padding bits without accepting a second spelling of a valid signature', () => {
    const c = client(), receipt = c.resourceReceipt('post_job', 'account', 'profile', 'job'), [payload, signature] = receipt.split('.'), alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const alias = signature!.slice(0, -1) + alphabet[alphabet.indexOf(signature!.at(-1)!) + 1];
    expect(Buffer.from(alias, 'base64url')).toEqual(Buffer.from(signature!, 'base64url'));
    expect(() => c.verifyResourceReceipt(`${payload}.${alias}`, 'post_job', 'account', 'job')).toThrow('invalid or expired');
    expect(c.verifyResourceReceipt(receipt, 'post_job', 'account', 'job')).toEqual({ profile_id: 'profile' });
  });
});
