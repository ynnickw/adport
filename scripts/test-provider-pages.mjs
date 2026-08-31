import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { providers } from './website-providers.mjs';
import { agentSetups, mcpBaseUrl } from './website-agent-setups.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const site = path.join(root, 'website');
const home = await readFile(path.join(site, 'index.html'), 'utf8');
const sitemap = await readFile(path.join(site, 'sitemap.xml'), 'utf8');
const pages = await Promise.all(['providers.html', ...providers.map(p => `providers/${p.slug}.html`)].map(async file => [file, await readFile(path.join(site, file), 'utf8')]));

test('Microsoft uses the official four-color symbol on every surface', () => {
  // Microsoft Learn: media/howto-add-branding-in-apps/ms-symbollockup_mssymbol_19.svg
  for (const [file, html] of [['index.html', home], ...pages]) {
    const logo = html.match(/<svg class="microsoft-logo"[\s\S]*?<\/svg>/)?.[0];
    if (!logo) { assert.notEqual(file, 'providers/microsoft-ads.html'); continue; }
    assert(logo.includes('viewBox="0 0 21 21"'), file);
    assert.deepEqual([...logo.matchAll(/fill="(#[a-f0-9]+)"/g)].map(match => match[1]), ['#f25022', '#00a4ef', '#7fba00', '#ffb900'], file);
  }
});

test('all provider setup tabs reuse the homepage agent logos', () => {
  for (const [file, html] of pages.filter(([file]) => file.startsWith('providers/'))) {
    for (const id of ['claude', 'cursor', 'chatgpt']) {
      const source = home.match(new RegExp(`<span class="agent agent-${id}">[\\s\\S]*?<\\/svg>`))[0];
      const logo = html.match(new RegExp(`<svg class="agent-brand-logo agent-brand-${id}"[\\s\\S]*?<\\/svg>`))?.[0];
      assert(logo, `${file}: missing ${id} logo`);
      assert(logo.includes('aria-hidden="true"'), `${file}: decorative logo must not repeat the heading`);
      assert.equal(logo.match(/<path[\s\S]*?<\/svg>/)[0], source.match(/<path[\s\S]*?<\/svg>/)[0], `${file}: ${id} logo differs from the homepage`);
    }
  }
});

test('provider instruction tabs have matching labels and panels with no-JavaScript content', () => {
  for (const [file, html] of [['index.html', home], ...pages.filter(([file]) => file.startsWith('providers/'))]) {
    assert.equal([...html.matchAll(/role="tab"/g)].length, 6, file);
    assert.equal([...html.matchAll(/role="tabpanel"/g)].length, 6, file);
    const vscodeTab = html.match(/<button[^>]*id="agent-tab-vscode"[\s\S]*?<\/button>/)?.[0];
    assert(vscodeTab?.includes('class="agent-brand-logo agent-brand-vscode"'), `${file}: VS Code logo missing`);
    assert(vscodeTab.includes('viewBox="0 0 16 16"'), file);
    for (const { id } of agentSetups) {
      assert(html.includes(`id="agent-tab-${id}" aria-controls="agent-panel-${id}"`), file);
      assert(html.includes(`id="agent-panel-${id}" role="tabpanel" aria-labelledby="agent-tab-${id}" tabindex="0">`), file);
    }
  }
});

test('all six public setup guides match the Cloud app instructions and commands', async () => {
  const source = await readFile(path.join(root, 'apps/cloud/app/dashboard/agents/agent-setup-guide.tsx'), 'utf8');
  const definition = source.match(/export const AGENT_SETUPS: Setup\[\] = (\[[\s\S]*?\n\]);/);
  assert(definition, 'Cloud setup definition changed; review the public guides');
  const cloudSetups = runInNewContext(`(${definition[1]})`);
  assert.equal(agentSetups.length, cloudSetups.length);
  for (const setup of agentSetups) {
    const cloud = cloudSetups.find(item => item.id === setup.id);
    assert(cloud, setup.id);
    for (const key of ['name', 'instructions', 'nextStep']) assert.equal(setup[key], cloud[key], `${setup.id}: ${key} drift`);
    assert.equal(setup.command(mcpBaseUrl), cloud.command(mcpBaseUrl), `${setup.id}: command drift`);
  }
});

test('MCP setup is not described as waitlist-only and the private app has no navigation links', () => {
  for (const [file, html] of [['index.html', home], ...pages]) {
    assert(!/hosted MCP is coming|hosted MCP connection is coming|ChatGPT via Cloud waitlist|ChatGPT Cloud waitlist|Hosted access is coming|Hosted MCP for Adport Cloud is on the waitlist/i.test(html), file);
    assert(!/href="https:\/\/app\.adport\.dev/.test(html), file);
    if (file !== 'providers.html') {
      const panel = html.match(/id="agent-panel-chatgpt"[\s\S]*?<\/div>/)?.[0];
      assert(panel?.includes('Choose OAuth'), file);
      assert(panel.includes(`${mcpBaseUrl}/mcp`), file);
      assert(!/waitlist/i.test(panel), file);
    }
  }
});

test('tabs switch by click and keyboard, wrap, and keep exactly one active panel', async () => {
  const tabs = ['claude', 'cursor', 'chatgpt'].map(id => ({
    handlers: {}, attributes: { 'aria-controls': `agent-panel-${id}` }, tabIndex: -1,
    setAttribute(name, value) { this.attributes[name] = value; },
    getAttribute(name) { return this.attributes[name]; },
    addEventListener(name, handler) { this.handlers[name] = handler; },
    focus() { focused = this; },
  }));
  let focused;
  const panels = tabs.map(tab => ({ id: tab.getAttribute('aria-controls'), hidden: false }));
  const tabList = { hidden: true, querySelectorAll: () => tabs };
  const setup = { querySelector: () => tabList, querySelectorAll: () => panels };
  const document = { querySelector: () => null, querySelectorAll: selector => selector === '[data-agent-tabs]' ? [setup] : [] };
  runInNewContext(await readFile(path.join(site, 'landing.js'), 'utf8'), { document });
  const expectSelected = index => {
    assert.equal(tabList.hidden, false);
    tabs.forEach((tab, i) => { assert.equal(tab.attributes['aria-selected'], String(i === index)); assert.equal(tab.tabIndex, i === index ? 0 : -1); });
    panels.forEach((panel, i) => assert.equal(panel.hidden, i !== index));
  };
  const key = (from, key, to) => {
    let prevented = false;
    tabs[from].handlers.keydown({ key, preventDefault() { prevented = true; } });
    assert(prevented); expectSelected(to); assert.equal(focused, tabs[to]);
  };
  expectSelected(0);
  tabs[1].handlers.click(); expectSelected(1);
  key(1, 'ArrowRight', 2); key(2, 'ArrowRight', 0); key(0, 'ArrowLeft', 2);
  key(2, 'Home', 0); key(0, 'End', 2);
});

test('covers all eleven advertising providers exactly once', () => {
  assert.deepEqual(providers.map(p => p.id).sort(), ['apple', 'google', 'linkedin', 'meta', 'microsoft', 'pinterest', 'reddit', 'snapchat', 'spotify', 'tiktok', 'x']);
  assert.equal(new Set(providers.map(p => p.slug)).size, 11);
});

test('titles, descriptions, editorial introductions, and workflow text are distinct', () => {
  for (const pattern of [/<title>(.*?)<\/title>/, /<meta name="description" content="(.*?)"/]) {
    assert.equal(new Set(pages.map(([, html]) => html.match(pattern)?.[1])).size, pages.length);
  }
  assert.equal(new Set(providers.map(p => p.intro)).size, providers.length);
  assert.equal(new Set(providers.flatMap(p => p.workflows.map(([, text]) => text))).size, providers.length * 3);
});

for (const p of providers) {
  test(`${p.name}: searchable, independently useful, linked, and honest about access`, async () => {
    const html = pages.find(([file]) => file === `providers/${p.slug}.html`)[1];
    const url = `https://www.adport.dev/providers/${p.slug}`;
    assert.equal((html.match(/<h1\b/g) || []).length, 1);
    assert(html.includes(`<link rel="canonical" href="${url}"`));
    assert(html.includes(`<meta property="og:url" content="${url}"`));
    assert(html.includes('name="twitter:card" content="summary_large_image"'));
    assert(!/noindex/.test(html));
    assert.equal((sitemap.match(new RegExp(`<loc>${url}</loc>`, 'g')) || []).length, 1);
    assert(home.includes(`href="/providers/${p.slug}"`));
    assert(html.includes(`adport connect ${p.id}`));
    assert(html.includes(`adport accounts --provider ${p.id}`));
    assert(html.includes('claude mcp add --transport stdio adport -- adport mcp'));
    assert(html.includes('Cloud waitlist'));
    assert(html.includes('Use the same Adport MCP endpoint and OAuth sign-in'));
    assert(html.includes('Provider access and approval are separate'));
    assert(html.includes('pending-operation token'));
    assert(html.includes('aria-live="polite"'));
    assert(html.includes('action="/api/waitlist"'));
    assert.equal(p.workflows.length, 3);
    assert.equal(p.prompts.length, 3);
    assert.equal(p.prerequisites.length, 3);
    const words = html.replace(/<svg[\s\S]*?<\/svg>|<script[\s\S]*?<\/script>/g, '').replace(/<[^>]+>/g, ' ').split(/\s+/).filter(Boolean);
    assert(words.length > 650, 'page should contain standalone guidance, not just a signup pitch');
    await access(path.join(root, 'packages', p.id, 'src', 'tools.ts'));
    await access(path.join(root, p.guide.split('#')[0]));
  });
}

test('all local links, fragments and assets resolve; forms have unique accessible identifiers', async () => {
  for (const [file, html] of pages) {
    const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
    assert.equal(new Set(ids).size, ids.length, `duplicate id in ${file}`);
    for (const [, refs] of html.matchAll(/(?:aria-controls|aria-describedby|for)="([^"]+)"/g)) {
      for (const id of refs.split(' ')) assert(ids.includes(id), `${file}: missing accessible target ${id}`);
    }
    for (const [, target] of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
      if (/^(https?:|mailto:)/.test(target)) continue;
      if (target.startsWith('#')) { assert(ids.includes(target.slice(1)), `${file}: missing fragment ${target}`); continue; }
      assert(target.startsWith('/'), `${file}: nested page needs root-relative assets: ${target}`);
      const pathname = target.split(/[?#]/)[0];
      const destination = pathname === '/' ? 'index.html' : path.extname(pathname) ? pathname.slice(1) : `${pathname.slice(1)}.html`;
      await access(path.join(site, destination));
    }
    const schema = JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);
    assert.equal(schema['@graph'][0]['@type'], 'WebPage');
    const crumbs = schema['@graph'][1].itemListElement;
    assert.equal(crumbs.at(-1).item, schema['@graph'][0].url);
    assert.deepEqual(crumbs.map(c => c.position), crumbs.map((_, i) => i + 1));
  }
});

test('provider-specific limits remain visible instead of implying complete parity', () => {
  const get = id => pages.find(([file]) => file === `providers/${providers.find(p => p.id === id).slug}.html`)[1];
  assert(get('spotify').includes('unpublished'));
  assert(get('x').includes('ROAS are not normalized'));
  assert(get('linkedin').includes('no native ad-group entity'));
  assert(get('pinterest').includes('maximum 90-day'));
  assert(get('snapchat').includes('swipes'));
  assert(get('apple').includes('Upload only the public key'));
});
