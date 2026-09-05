import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, '..');
const repositoryRoot = resolve(packageRoot, '../..');
const outputDirectory = join(repositoryRoot, 'docs/submissions/assets');
const temporaryDirectory = join(packageRoot, '.submission-previews');
const prepareOnly = process.argv.includes('--prepare-only');
const chrome = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].find((candidate) => candidate && existsSync(candidate));
if (!chrome && !prepareOnly) throw new Error('Chrome is required. Set CHROME_PATH to its executable.');

const source = readFileSync(join(packageRoot, 'src/ui.ts'), 'utf8');
const marker = 'export const ADPORT_UI_HTML = String.raw`';
const start = source.indexOf(marker);
const end = source.lastIndexOf('`;');
if (start < 0 || end <= start) throw new Error('Unable to extract ADPORT_UI_HTML from src/ui.ts.');
const appHtml = source.slice(start + marker.length, end);

const providerNames = {
  google: 'Google Ads',
  meta: 'Meta Ads',
  tiktok: 'TikTok Ads',
  apple: 'Apple Ads',
  microsoft: 'Microsoft Advertising',
  snapchat: 'Snapchat Ads',
};

const fixtures = {
  accounts: {
    viewportHeight: 580,
    tool: 'accounts_list',
    view: 'accounts',
    result: {
      accounts: [
        { provider: 'google', id: 'demo-google-eu', name: 'Northwind EU', currency: 'EUR', status: 'ENABLED' },
        { provider: 'meta', id: 'demo-meta-brand', name: 'Northwind Brand', currency: 'EUR', status: 'ACTIVE' },
        { provider: 'tiktok', id: 'demo-tiktok-growth', name: 'Northwind Growth', currency: 'EUR', status: 'ACTIVE' },
        { provider: 'apple', id: 'demo-apple-search', name: 'Northwind Search Ads', currency: 'EUR', status: 'API CAMPAIGN MANAGER' },
        { provider: 'microsoft', id: 'demo-microsoft-emea', name: 'Northwind EMEA', currency: 'EUR', status: 'ACTIVE' },
        { provider: 'snapchat', id: 'demo-snapchat', name: 'Northwind Snapchat', currency: 'EUR', status: 'PENDING' },
      ],
      errors: [],
    },
  },
  report: {
    viewportHeight: 640,
    tool: 'report',
    view: 'report',
    result: {
      rows: [
        { provider: 'google', accountId: 'demo-google-eu', entity: { id: 'g-1', name: 'Brand Search', status: 'ENABLED' }, metrics: { spend: 1284.2, impressions: 142800, clicks: 8120, conversions: 416, conversion_value: 8240 } },
        { provider: 'meta', accountId: 'demo-meta-brand', entity: { id: 'm-1', name: 'Creative Winners', status: 'ACTIVE' }, metrics: { spend: 936.7, impressions: 395400, clicks: 11630, conversions: 287, conversion_value: 5598 } },
        { provider: 'tiktok', accountId: 'demo-tiktok-growth', entity: { id: 't-1', name: 'UGC Prospecting', status: 'ACTIVE' }, metrics: { spend: 708.5, impressions: 608200, clicks: 9320, conversions: 181, conversion_value: 3274 } },
        { provider: 'apple', accountId: 'demo-apple-search', entity: { id: 'a-1', name: 'High Intent Keywords', status: 'ENABLED' }, metrics: { spend: 482.4, impressions: 89400, clicks: 6740, conversions: 352, conversion_value: 4224 } },
        { provider: 'microsoft', accountId: 'demo-microsoft-emea', entity: { id: 'b-1', name: 'Competitor Search', status: 'ACTIVE' }, metrics: { spend: 318.1, impressions: 51600, clicks: 2940, conversions: 94, conversion_value: 1739 } },
      ],
      truncated: false,
    },
  },
  operation: {
    viewportHeight: 410,
    tool: 'google_set_budget',
    view: 'operation',
    result: {
      status: 'pending_validation',
      pending_operation_id: 'pending_demo_review',
      preview: {
        summary: 'Increase "Brand Search" daily budget from EUR 120 to EUR 132',
        serverValidated: true,
        changes: [
          'Daily budget increases by 10% for Brand Search',
          'Campaign targeting, bidding, creatives, and status stay unchanged',
        ],
        coercions: ['Campaign remains PAUSED until it is explicitly enabled outside this preview'],
        budgetDeltas: [{ target: 'Daily budget', fromMicros: 120000000, toMicros: 132000000 }],
      },
    },
  },
  status: {
    viewportHeight: 300,
    tool: 'meta_set_campaign_status',
    view: 'operation',
    result: {
      status: 'pending_validation', applied: false, pending_operation_id: 'pending_demo_status',
      preview: {
        summary: 'Set campaign "Meta review campaign" status PAUSED → PAUSED',
        changes: ['~ campaign demo-meta-review status PAUSED → PAUSED'],
        coercions: [], budgetDeltas: [], serverValidated: true,
      },
    },
  },
};

// Currency is supplied by the shared report handler, not inferred by the card.
fixtures.report.result.date_range = 'last_7_days';
fixtures.report.result.rows.forEach((row) => { row.currency = 'EUR'; });
fixtures.report.result.rows.push({ ...fixtures.report.result.rows[0], accountId: 'demo-google-us', currency: 'USD', entity: { id: 'g-us', name: 'US Search', status: 'PAUSED' } });

mkdirSync(outputDirectory, { recursive: true });
mkdirSync(temporaryDirectory, { recursive: true });

for (const [name, fixture] of Object.entries(fixtures)) {
  const structuredContent = {
    ...fixture.result,
    _adport: { tool: fixture.tool, view: fixture.view, providerNames },
  };
  const notification = JSON.stringify({
    jsonrpc: '2.0',
    method: 'ui/notifications/tool-result',
    params: { structuredContent },
  });
  const htmlPath = join(temporaryDirectory, `${name}.html`);
  // Exercise a real parent/iframe boundary. This is a synthetic MCP host, not a
  // claim that ChatGPT/Claude executed these fixture tools.
  writeFileSync(join(temporaryDirectory, `${name}-widget.html`), appHtml);
  writeFileSync(htmlPath, `<!doctype html><html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Adport synthetic ${name} preview</title><body style="margin:0;padding:20px;background:#f6f6f4"><iframe title="Adport ${name}" src="${name}-widget.html" style="width:100%;height:850px;border:0"></iframe><script>
    const frame=document.querySelector('iframe');
    const params=new URLSearchParams(location.search);
    if(params.get('mobile')==='1') frame.style.width='375px';
    window.addEventListener('message', event=>{
      if(event.source!==frame.contentWindow) return;
      if(event.data.method==='ui/initialize') frame.contentWindow.postMessage({jsonrpc:'2.0',id:event.data.id,result:{hostContext:{theme:params.get('theme')==='dark'?'dark':'light',locale:'en-US'}}},'*');
      if(event.data.method==='ui/notifications/initialized') frame.contentWindow.postMessage(${notification},'*');
      if(event.data.method==='ui/notifications/size-changed') frame.style.height=event.data.params.height+'px';
    });
  </script></body></html>`);

  if (prepareOnly) continue;

  execFileSync(chrome, [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    `--window-size=1100,${fixture.viewportHeight}`,
    `--screenshot=${join(outputDirectory, `mcp-${name}.png`)}`,
    pathToFileURL(htmlPath).href,
  ], { stdio: 'inherit' });
}

if (!prepareOnly) rmSync(temporaryDirectory, { recursive: true, force: true });
console.log(prepareOnly ? `Prepared synthetic iframe fixtures in ${temporaryDirectory}` : `Rendered ${Object.keys(fixtures).length} previews to ${outputDirectory}`);
