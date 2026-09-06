import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkConnectorCatalog } from './check-connector-catalog.mjs';

const tool = (name = 'google_gaql') => ({
  name, description: 'Read account data.', inputSchema: { type: 'object', properties: { account_id: { type: 'string' } } },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  _meta: { ui: { resourceUri: 'ui://adport/insight-card-v1.html' } },
});
const catalog = (...tools) => ({ tools });
const check = (review, production = catalog(tool()), scope = ['google']) => checkConnectorCatalog(production, review, scope);

test('matches complete production metadata regardless of tool/key ordering', () => {
  const read = tool();
  const second = tool('google_set_budget');
  const reordered = Object.fromEntries(Object.entries(read).reverse());
  assert.equal(check(catalog(second, reordered), catalog(read, second)).ok, true);
  assert.equal(check({ jsonrpc: '2.0', id: 1, result: catalog(read) }).ok, true);
});

test('rejects the synthetic reviewer surface even when both snapshots match', () => {
  const demo = catalog(tool('accounts_list'), tool('report'), tool('demo_list_campaigns'), tool('demo_set_budget'));
  const result = check(demo, demo);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(error => error.includes('non-production tool demo_set_budget')));
  assert.ok(result.errors.some(error => error.includes('missing native google tools')));
});

test('rejects missing and added tools, not just equal counts', () => {
  const result = check(catalog(tool('google_set_budget')));
  assert.ok(result.errors.some(error => error.includes('missing production tool google_gaql')));
  assert.ok(result.errors.some(error => error.includes('absent from production')));
});

for (const field of ['description', 'inputSchema', 'annotations', '_meta', 'securitySchemes']) {
  test(`detects ${field} drift in the saved review snapshot`, () => {
    const changed = tool();
    changed[field] = field === 'description' ? 'Different behavior.' : { changed: true };
    assert.equal(check(catalog(changed)).ok, false);
  });
}

test('rejects empty, malformed, duplicate and paginated exports', () => {
  for (const value of [null, {}, catalog(), catalog(null), catalog(tool(), tool()), { ...catalog(tool()), nextCursor: 'more' }]) {
    assert.equal(check(value).ok, false);
  }
});

test('does not treat present tools as provider approval', () => {
  const both = catalog(tool(), tool('meta_api_read'));
  assert.equal(check(both, both).ok, false);
  assert.equal(check(both, both, ['google', 'meta']).ok, true);
  assert.equal(check(both, both, []).ok, false);
  assert.equal(check(both, both, ['invented']).ok, false);
});

test('rejects synthetic provenance even without demo tool names', () => {
  assert.equal(check({ ...catalog(tool()), data_source: 'synthetic' }).ok, false);
});

test('rejects missing annotations even if both snapshots omit them', () => {
  const missing = tool();
  delete missing.annotations.openWorldHint;
  assert.equal(check(catalog(missing), catalog(missing)).ok, false);
});
