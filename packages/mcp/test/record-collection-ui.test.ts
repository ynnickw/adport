import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ADPORT_UI_HTML, structuredResult, toolTitle } from '../src/ui.js';

const open: JSDOM[] = [];
afterEach(() => { for (const dom of open.splice(0)) dom.window.close(); });

function mount(rows: unknown[], tool = 'google_gaql', extra = {}) {
  const callTool = vi.fn();
  const dom = new JSDOM(ADPORT_UI_HTML, {
    runScripts: 'dangerously',
    beforeParse(window) { Object.defineProperty(window, 'openai', { value: { callTool } }); },
  });
  open.push(dom);
  const provider = tool.split('_')[0]!;
  const content = structuredResult(tool, 'data', { rows, ...extra }, undefined, undefined, undefined, undefined, undefined, { provider });
  dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
    source: dom.window.parent,
    data: { jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { structuredContent: content } },
  }));
  const document = dom.window.document;
  return {
    dom, document, callTool,
    title: document.querySelector('h2')?.textContent,
    headers: [...document.querySelectorAll('thead th')].map(cell => cell.textContent),
    visible: () => [...document.querySelectorAll('tbody tr:not([hidden])')].map(row => [...row.children].map(cell => cell.textContent)),
  };
}
const country = (id: string, name: string, countryCode: string, targetType = 'Country') => ({
  geoTargetConstant: { id, name, countryCode, targetType, resourceName: 'geoTargetConstants/' + id },
});

describe('shared record presentation', () => {
  it('shows a country lookup in query order and filters all loaded names, codes and IDs locally', () => {
    const rows = [
      country('2036', 'Australia', 'AU'), country('2056', 'Belgium', 'BE'), country('2208', 'Denmark', 'DK'),
      country('2246', 'Finland', 'FI'), country('2250', 'France', 'FR'),
      ...Array.from({ length: 12 }, (_, i) => country(String(6000 + i), 'Sample ' + i, 'ZZ')),
    ];
    const { dom, document, title, headers, visible, callTool } = mount(rows);
    expect(title).toBe('Countries');
    expect(headers).toEqual(['Country', 'Country code', 'Target ID']);
    expect(visible()).toHaveLength(17);
    expect(visible()[0]).toEqual(['Australia', 'AU', '2036']);
    expect(visible().at(-1)).toEqual(['Sample 11', 'ZZ', '6011']);
    expect(document.querySelector('.context')?.textContent).toBe('17 results');
    const search = document.querySelector<HTMLInputElement>('input[type=search]')!;
    const filter = (query: string) => { search.value = query; search.dispatchEvent(new dom.window.Event('input')); };
    filter('fInLaNd'); expect(visible()).toEqual([['Finland', 'FI', '2246']]);
    filter('zz'); expect(visible()).toHaveLength(12);
    filter('6011'); expect(visible()).toEqual([['Sample 11', 'ZZ', '6011']]);
    filter('missing'); expect(visible()).toHaveLength(0);
    expect(document.querySelector('[data-collection-empty]')?.hasAttribute('hidden')).toBe(false);
    expect(document.querySelector('[role=status]')?.textContent).toContain('0 of 17');
    search.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
    expect(visible()).toHaveLength(17);
    expect(search.value).toBe('');
    expect(JSON.parse(document.querySelector('details pre')!.textContent!).rows).toEqual(rows);
    expect(callTool).not.toHaveBeenCalled();
    expect(toolTitle('google_gaql')).toBe('Query Google Ads');
  });

  it('keeps geography types when they vary or were the only selected field', () => {
    const mixed = mount([country('201', 'Vienna', 'AT', 'City'), country('2036', 'Australia', 'AU')]);
    expect(mixed.title).toBe('Target locations');
    expect(mixed.headers).toEqual(['Location', 'Country code', 'Type', 'Target ID']);
    expect(mixed.visible()[0]).toEqual(['Vienna', 'AT', 'City', '201']);
    const onlyType = mount([{ geoTargetConstant: { targetType: 'Country' } }]);
    expect(onlyType.visible()).toEqual([['Country']]);
    const untyped = mount([{ geoTargetConstant: { name: 'Georgia', countryCode: 'US' } }]);
    expect(untyped.title).toBe('Target locations');
  });

  it('states a shared type once for other providers and keeps per-row differences in the table', () => {
    const list = (type: string) => mount([{ name: 'First', type: 'Physical' }, { name: 'Second', type }], 'pinterest_catalog_items');
    const same = list('Physical');
    expect(same.document.querySelector('.collection-heading p')?.textContent).toBe('Type · Physical');
    expect(same.headers).toEqual(['Name']);
    expect(list('Digital').headers).toEqual(['Name', 'Type']);
  });

  it('uses a common projection across providers, includes late fields and preserves missing, false and zero', () => {
    const { headers, visible, document } = mount([
      { item: { id: '9007199254740993123', displayName: 'Lamp <desk>', active: false, stock: 0, secretToken: 'private-token' } },
      { item: { id: '2', displayName: 'Chair', active: true, stock: null, finish: 'Oak' } },
    ], 'pinterest_catalog_lookup', { warnings: ['Only active stores were queried.'] });
    expect(headers).toEqual(['Display name', 'Active', 'Stock', 'Finish', 'ID']);
    expect(visible()[0]).toEqual(['Lamp <desk>', 'No', '0', '—', '9007199254740993123']);
    expect(visible()[1]).toEqual(['Chair', 'Yes', '—', 'Oak', '2']);
    expect(document.querySelector('table')?.textContent).not.toMatch(/private-token|Secret/);
    expect(document.querySelector('desk')).toBeNull();
    expect(document.querySelector('.notice')?.textContent).toBe('Only active stores were queried.');
  });

  it('qualifies same-named fields in joins and keeps resource paths that distinguish identical IDs', () => {
    const rows = ['First', 'Second'].map((name, i) => ({
      campaign: { name: 'Brand', id: '10' },
      adGroup: { name, id: '7', resourceName: 'customers/' + i + '/adGroups/7' },
    }));
    const { title, headers, visible } = mount(rows);
    expect(title).toBe('Google Ads query results');
    expect(headers[0]).toBe('Ad group name');
    expect(headers).toEqual(expect.arrayContaining(['Campaign name', 'Ad group ID', 'Campaign ID', 'Resource name']));
    expect(visible().map(row => row[0])).toEqual(['First', 'Second']);
    expect(visible()[1]).toContain('customers/1/adGroups/7');
  });

  it('leads with a distinguishing ID when every returned name is the same', () => {
    const { headers, visible } = mount(['001', '002'].map(id => ({ entry: { name: 'Default', id } })), 'pinterest_catalog_lookup');
    expect(headers).toEqual(['ID', 'Name']);
    expect(visible()).toEqual([['001', 'Default'], ['002', 'Default']]);
  });

  it('keeps heterogeneous records individually labeled and omits an anonymous heading when fields suffice', () => {
    const { document, headers } = mount([
      { id: '1', item: { title: 'Lamp', finish: 'Brass' } },
      { id: '2', store: { displayName: 'Showroom', city: 'Munich' } },
    ], 'pinterest_catalog_lookup');
    expect(headers).toEqual([]);
    expect([...document.querySelectorAll('.record-name strong')].map(node => node.textContent)).toEqual(['Lamp', 'Showroom']);
    const anonymous = mount([{ details: { owners: ['A', 'B'] } }], 'pinterest_product_details');
    expect(anonymous.document.querySelector('.record-list')?.textContent).toBe('OwnersAB');
  });

  it('reuses the same field rules for languages and for cards containing rich, nested records', () => {
    const languages = mount([{ languageConstant: { code: 'de', name: 'German', id: '1001' } }]);
    expect(languages.title).toBe('Languages');
    expect(languages.headers).toEqual(['Language', 'Code', 'ID']);
    const rich = mount([{ product: { name: 'Reading lamp', id: 'p1', options: ['Brass', 'Steel'] } }], 'pinterest_product_details');
    expect(rich.document.querySelector('.record-name strong')?.textContent).toBe('Reading lamp');
    expect(rich.document.querySelector('.record-fields dt')?.textContent).toBe('Options');
  });

  it('converts string monetary units with their currency and leaves other units and IDs intact', () => {
    const { headers, visible } = mount([
      { campaignBudget: { name: 'Daily', amountMicros: '1250000', durationMicros: '150', id: '9007199254740993123' }, customer: { currencyCode: 'EUR' } },
      { campaignBudget: { name: 'Zero', amountMicros: '0', durationMicros: '0', id: '2' }, customer: { currencyCode: 'USD' } },
    ]);
    expect(headers).toEqual(expect.arrayContaining(['Amount', 'Duration micros', 'ID']));
    expect(visible()[0]).toEqual(expect.arrayContaining(['€1.25', '150', '9007199254740993123']));
    expect(visible()[1]).toEqual(expect.arrayContaining(['$0.00', '0']));
  });

  it('keeps empty reads honest and gives metric queries their existing report view', () => {
    const empty = mount([]);
    expect(empty.title).toBe('Google Ads query results');
    expect(empty.document.querySelector('table')).toBeNull();
    expect(empty.document.querySelector('main')?.textContent).toContain('No results returned');
    const report = mount([{ campaign: { name: 'Search' }, metrics: { clicks: '5' } }]);
    expect(report.document.querySelector('[data-native-report]')).not.toBeNull();
  });

  it('states the display limit and keeps a later geography type in the full response', () => {
    const rows = Array.from({ length: 1000 }, (_, i) => country(String(i), 'Country ' + i, 'ZZ'));
    rows.push(country('1001', 'Munich', 'DE', 'City'));
    const { document, title, headers, visible } = mount(rows);
    expect(title).toBe('Target locations');
    expect(headers).toContain('Type');
    expect(visible()).toHaveLength(1000);
    expect(document.querySelector('main')?.textContent).toContain('Showing 1,000 of 1,001 results.');
    expect(JSON.parse(document.querySelector('details pre')!.textContent!).rows.at(-1)).toEqual(rows.at(-1));
  });
});
