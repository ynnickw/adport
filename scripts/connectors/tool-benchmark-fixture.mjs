import { readFileSync } from 'node:fs';

const north = '11111111-1111-4111-8111-111111111111';
const south = '22222222-2222-4222-8222-222222222222';
const googleAccount = '1234567890';
const metaAccount = 'act_246810';
const campaign = '987654321';
const preview = 'benchmark-preview-only';

export const cases = [
  {
    id: 'report',
    prompt: 'For the Northwind project, what did Google Ads spend and how many clicks did it get yesterday across the whole account?',
    tool: 'report',
    args: args => args.provider === 'google' && args.date_range === 'yesterday' && args.level === 'account'
      && args.metrics?.includes('spend') && args.metrics?.includes('clicks'),
    answer: /(?=[\s\S]*(?:23\.45|23,45))(?=[\s\S]*\b120\b)/,
  },
  {
    id: 'budget-preview',
    prompt: 'In Northwind, preview changing Google Ads campaign 987654321 in account 1234567890 to USD 45 per day. Show me the proposed change and stop before applying it.',
    tool: 'google_set_budget',
    args: args => args.account_id === googleAccount && args.campaign_id === campaign
      && args.daily_budget_micros === 45_000_000 && !Object.hasOwn(args, 'pending_operation_id'),
    answer: /\b45\b/,
  },
  {
    id: 'specialist',
    prompt: 'List the Meta tracking pixels owned by ad account act_246810 in the Northwind project.',
    tool: 'meta_list_pixels',
    args: args => args.account_id === metaAccount,
    answer: /Northwind Web Pixel/i,
    hiddenArgs: args => /pixel/i.test(args.query ?? '') && (!args.provider || args.provider === 'meta'),
    hiddenAnswer: /tool access|full profile|manage access/i,
  },
  {
    id: 'general-knowledge',
    prompt: 'What does CTR mean in advertising?',
    answer: /click.through rate/i,
  },
];

export const role = 'Complete the request using the Adport connection when relevant. The connection has access to multiple projects. Keep preview-only requests in preview.';

export function evaluate(test, catalog, calls, answer) {
  const hidden = test.hiddenArgs && !catalog.tools.some(tool => tool.name === test.tool);
  const target = hidden ? 'capabilities_list' : test.tool;
  const matching = calls.filter(call => call.name === target);
  const checkArgs = hidden ? test.hiddenArgs : test.args;
  const applyAttempt = calls.some(({ args }) => Object.hasOwn(args, 'pending_operation_id'));
  const selected = target ? matching.length > 0 : calls.length === 0;
  const argsCorrect = target ? matching.some(({ args }) => args.project_id === north && checkArgs(args)) : calls.length === 0;
  const scopeCorrect = target
    ? calls[0]?.name === 'projects_list' && calls.slice(1).every(({ args }) => args.project_id === north)
    : calls.length === 0;
  const answerCorrect = (hidden ? test.hiddenAnswer : test.answer).test(answer);
  return { expectedTool: target ?? null, selected, argsCorrect, scopeCorrect, answerCorrect, applyAttempt,
    passed: selected && argsCorrect && scopeCorrect && answerCorrect && !applyAttempt };
}

export function readCatalog(path) {
  const catalog = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(catalog.tools) || !catalog.tools.length || catalog.nextCursor) throw new Error('Expected a complete fixture catalog');
  return catalog;
}

export function fixtureResult(catalog, name, args) {
  const tool = catalog.tools.find(tool => tool.name === name);
  if (!tool) return { error: 'This tool is unavailable in the fixture catalog.' };
  const shape = tool.outputSchema?.properties?._adport;
  const metadata = shape ? { _adport: {
    tool: name, view: shape.properties.view.const, providerNames: { google: 'Google Ads', meta: 'Meta' },
    ...(name === 'projects_list' ? {} : { context: { project_id: north } }),
  } } : {};
  if (name === 'projects_list') return { projects: [
    { id: south, name: 'Contoso', organization_name: 'Benchmark', role: 'member', providers: ['google', 'meta'] },
    { id: north, name: 'Northwind', organization_name: 'Benchmark', role: 'member', providers: ['google', 'meta'] },
  ], ...metadata };
  if (args.project_id !== north) return { error: 'Choose the Northwind project_id from projects_list.' };
  if (Object.hasOwn(args, 'pending_operation_id')) return { error: 'Applying changes is disabled in this fixture.' };
  if (name === 'report') {
    return {
      rows: [{ provider: 'google', accountId: googleAccount, currency: 'USD',
        entity: { level: 'account', id: googleAccount, name: 'Northwind Google' }, metrics: { spend: 23.45, clicks: 120 } }],
      summary: { scope: 'returned_rows', complete: true, groups: [] },
      truncated: false, errors: [], warnings: [], date_range: args.date_range ?? 'yesterday', ...metadata,
    };
  }
  if (name === 'accounts_list') {
    return { accounts: [
      { id: googleAccount, name: 'Northwind Google', provider: 'google', currency: 'USD' },
      { id: metaAccount, name: 'Northwind Meta', provider: 'meta', currency: 'USD' },
    ].filter(account => !args.provider || account.provider === args.provider), errors: [], ...metadata };
  }
  if (name === 'google_set_budget') return {
    status: 'pending_validation', applied: false, pending_operation_id: preview,
    preview: { summary: 'Increase daily budget from USD 30 to USD 45.', changes: [], coercions: [],
      budgetDeltas: [{ target: campaign, currency: 'USD', fromMicros: 30_000_000, toMicros: 45_000_000 }], serverValidated: false },
    next_step: 'To apply after approval, repeat with pending_operation_id.', ...metadata,
  };
  if (name === 'meta_list_pixels') return { rows: [{ id: '135790', name: 'Northwind Web Pixel' }], truncated: false, ...metadata };
  if (name === 'capabilities_list') {
    const enabled = catalog.tools.some(tool => tool.name === 'meta_list_pixels');
    return {
      profile: enabled ? 'full' : 'standard', selected_providers: enabled ? null : ['google', 'meta'],
      platforms: [], categories: [], total_matches: 1, truncated: false,
      tools: [{ name: 'meta_list_pixels', provider: 'meta', category: 'measurement', description: 'Read account-owned Meta pixels.',
        read_only: true, enabled,
        blockers: enabled ? [] : ['profile_disabled'],
        next_steps: enabled ? [] : ['Choose Full under Tool access, save, then refresh the assistant’s tools.'] }],
      manage_access_url: 'https://adport.example/tool-access', instructions: 'Explain blockers and link to Manage tool access.', ...metadata,
    };
  }
  return { error: 'This synthetic test fixture has no result for that operation.' };
}

export function modelDefinitions(catalog) {
  return catalog.tools.map(({ name, description, inputSchema: { $schema, ...schema } }) => ({ name, description, schema }));
}
