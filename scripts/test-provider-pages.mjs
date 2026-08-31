import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';
import { providers } from './website-providers.mjs';

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
    assert(!/noindex|app\.adport\.dev/.test(html));
    assert.equal((sitemap.match(new RegExp(`<loc>${url}</loc>`, 'g')) || []).length, 1);
    assert(home.includes(`href="/providers/${p.slug}"`));
    assert(html.includes(`adport connect ${p.id}`));
    assert(html.includes(`adport accounts --provider ${p.id}`));
    assert(html.includes('claude mcp add --transport stdio adport -- adport mcp'));
    assert(html.includes('Cloud waitlist'));
    assert(html.includes('not a hosted ChatGPT connector URL'));
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
