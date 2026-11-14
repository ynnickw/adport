import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { LinkedInAdsClient } from '../src/client.js';
import { linkedinErrorDetails } from '../src/native-errors.js';

// Native error envelope: LinkedIn-owned /marketing/error-responses, reviewed2026-11-04.
describe('safe LinkedIn validation diagnostics', () => {
  it('keeps machine codes, field paths and numeric constraints while dropping descriptions and submitted values', async () => {
    const result = await linkedinErrorDetails(Response.json({ status: 422, code: 'MULTIPLE_VALIDATIONS_FAILED', serviceErrorCode: 10007, message: 'private-message', errorDetails: { inputErrors: [{ code: 'FIELD_VALUE_TOO_LOW', description: 'private description', input: { inputPath: { fieldPath: '/Campaign/dailyBudget/amount' }, value: { stringValue: 'private submitted value' } }, minValue: '10.00', maxValue: '1000.00', arbitrary: 'private arbitrary' }], conditionalInputErrors: [{ code: 'DATE_TOO_EARLY', input: { inputPath: { fieldPath: '/Campaign/runSchedule/start' }, value: { decimalValue: 'private' } }, minLength: 1 }] } }, { status: 422, headers: { 'x-li-uuid': 'support-request-id' } }), []);
    expect(result).toEqual({ http_status: 422, request_id: 'support-request-id', native_code: 'MULTIPLE_VALIDATIONS_FAILED', service_error_code: 10007, input_errors: [{ conditional: false, code: 'FIELD_VALUE_TOO_LOW', field_path: '/Campaign/dailyBudget/amount', min_value: '10.00', max_value: '1000.00' }, { conditional: true, code: 'DATE_TOO_EARLY', field_path: '/Campaign/runSchedule/start', min_length: 1 }] });
    expect(JSON.stringify(result)).not.toContain('private');
  });

  it('drops credential echoes even inside otherwise well-shaped machine fields and rejects raw/oversized error bodies', async () => {
    const result = await linkedinErrorDetails(Response.json({ code: 'ACCESS_TOKEN_SECRET', errorDetails: { inputErrors: [{ code: 'ACCESS_TOKEN_SECRET', input: { inputPath: { fieldPath: '/Campaign/ACCESS_TOKEN_SECRET' } } }] } }, { status: 403, headers: { 'x-li-uuid': 'ACCESS_TOKEN_SECRET' } }), ['ACCESS_TOKEN_SECRET']);
    expect(result).toEqual({ http_status: 403 });
    expect(await linkedinErrorDetails(new Response('<html>private HTML</html>', { status: 500 }), [])).toEqual({ http_status: 500 });
    expect(await linkedinErrorDetails(Response.json({ message: 'private'.repeat(10000) }, { status: 422 }), [])).toEqual({ http_status: 422 });
  });

  it('exposes safe field diagnostics on the client error and never repeats failed native writes', async () => {
    let calls = 0;
    const client = new LinkedInAdsClient({ accessToken: 'private-token' }, async () => { calls++; return Response.json({ code: 'FIELD_VALUE_TOO_LOW', message: 'private-token', errorDetails: { inputErrors: [{ code: 'FIELD_VALUE_TOO_LOW', input: { inputPath: { fieldPath: '/Campaign/dailyBudget/amount' } }, minValue: '10' }] } }, { status: 422 }); });
    await expect(client.create('adAccounts/7/adCampaigns', {})).rejects.toMatchObject({ code: 'PROVIDER_ERROR', message: 'linkedin: HTTP 422 [FIELD_VALUE_TOO_LOW].', details: { http_status: 422, native_code: 'FIELD_VALUE_TOO_LOW', input_errors: [{ code: 'FIELD_VALUE_TOO_LOW', field_path: '/Campaign/dailyBudget/amount', min_value: '10' }] } });
    expect(calls).toBe(1);
    await expect(client.get('adAccounts/7', z.object({}))).rejects.not.toThrow('private-token');
    expect(calls).toBe(2);
  });
});
