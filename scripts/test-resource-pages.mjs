import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';
import { articles, articlesInCluster, clusters, sources } from './website-resources.mjs';
import { escape } from './resource-content/shared.mjs';
import { chatgptGuideForProvider } from './resource-content/chatgpt-connections.mjs';
import { agentSetups, mcpBaseUrl } from './website-agent-setups.mjs';
const site = fileURLToPath(new URL('../website/', import.meta.url));
const sitemap = await readFile(path.join(site, 'sitemap.xml'), 'utf8');
const home = await readFile(path.join(site, 'index.html'), 'utf8');
const files = ['resources.html', ...clusters.map(c => `resources/${c.slug}.html`), ...articles.map(a => `resources/${a.slug}.html`)];
const pages = await Promise.all(files.map(async file => [file, await readFile(path.join(site, file), 'utf8')]));

test('distinct topic clusters have original, source-linked guides', () => {
  assert.equal(new Set(clusters.map(c => c.slug)).size, clusters.length);
  assert(articles.length >= 10);
  assert.equal(new Set(articles.map(a => a.slug)).size, articles.length);
  assert.equal(new Set(articles.map(a => a.title)).size, articles.length);
  assert.equal(new Set(articles.map(a => a.description)).size, articles.length);
  for (const c of clusters) assert(articlesInCluster(c.slug).length >= 3, c.slug);
  for (const a of articles) {
    assert(clusters.some(c => c.slug === a.cluster), a.slug);
    assert(a.sections.length >= 5, a.slug);
    assert(a.sources.length >= 2, a.slug);
    assert(a.sources.every(id => sources[id]), a.slug);
    assert.equal(new Set(a.sections.map(s => s.id)).size, a.sections.length, a.slug);
    assert(!/—|guaranteed (rank|traffic|results)/i.test(a.sections.map(s => s.html).join(' ')), a.slug);
  }
});

test('ChatGPT setup matches the shared client flow and reuses one Google guide URL', async () => {
  const guides = articlesInCluster('connect-ads-to-chatgpt');
  const setup = guides.find(a => a.slug === 'connect-ads-to-chatgpt-mcp');
  const setupHtml = setup.sections.map(s => s.html).join('');
  const client = agentSetups.find(a => a.id === 'chatgpt');
  assert(setupHtml.includes(client.instructions));
  assert(setupHtml.includes(client.nextStep));
  assert(setupHtml.includes(client.command(mcpBaseUrl)));
  assert.equal(articles.filter(a => a.slug === 'google-ads-with-chatgpt').length, 1);
  assert(articlesInCluster('ai-ad-management').some(a => a.slug === 'google-ads-with-chatgpt'));
  for (const [provider, slug] of Object.entries(chatgptGuideForProvider)) {
    const guide = guides.find(a => a.slug === slug);
    assert(guide, slug);
    assert(guide.marks.includes(provider) && guide.marks.includes('chatgpt'), slug);
    const body = guide.sections.map(s => s.html).join('');
    assert(!/claude mcp add|adport mcp --http/.test(body), slug);
    assert(body.includes('/resources/connect-ads-to-chatgpt-mcp'), slug);
    const integration = await readFile(path.join(site, `providers/${provider}-ads.html`), 'utf8');
    assert(integration.includes(`href="/resources/${slug}"`), slug);
  }
  assert(home.includes('id="chatgpt-guides-title"'));
  assert(home.includes('href="/resources/connect-ads-to-chatgpt"'));
});

test('each guide has one heading, canonical and article data that describes its visible content', () => {
  for (const a of articles) {
    const html = pages.find(([file]) => file === `resources/${a.slug}.html`)[1];
    assert.equal((html.match(/<h1\b/g) || []).length, 1, a.slug);
    assert(html.includes(`<h1>${escape(a.title)}</h1>`), a.slug);
    const canonical = `https://www.adport.dev/resources/${a.slug}`;
    assert(html.includes(`<link rel="canonical" href="${canonical}"`), a.slug);
    assert(html.includes(`<meta name="description" content="${escape(a.description)}"`), a.slug);
    const schema = JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);
    const article = schema['@graph'].find(item => item['@type'] === 'Article');
    assert.equal(article.headline, a.title);
    assert.equal(article.mainEntityOfPage, canonical);
    assert.equal(article.author.name, 'Adport');
    assert(article.wordCount > 500, a.slug);
    for (const s of a.sections) assert(html.includes(`id="${s.id}"`), a.slug);
  }
});

test('hubs, sitemap and related guides make every article discoverable', () => {
  const hub = pages.find(([file]) => file === 'resources.html')[1];
  for (const a of articles) {
    const href = `/resources/${a.slug}`;
    assert(hub.includes(`href="${href}"`), a.slug);
    assert(pages.find(([file]) => file === `resources/${a.cluster}.html`)[1].includes(`href="${href}"`), a.slug);
    assert.equal(sitemap.split(`<loc>https://www.adport.dev${href}</loc>`).length - 1, 1, a.slug);
    const html = pages.find(([file]) => file === `resources/${a.slug}.html`)[1];
    assert(html.includes('resource-related'), a.slug);
    assert(html.includes('href="/pricing"'), a.slug);
    assert(html.includes('href="https://app.adport.dev/?mode=signup"'), a.slug);
  }
  assert(home.includes('href="/resources"'));
  assert(home.includes('id="resources-title"'));
});

test('resource navigation, local assets and fragments resolve', async () => {
  for (const [file, html] of pages) {
    assert(!/noindex|\/guides\/developer-mode/.test(html), file);
    assert(!/\sstyle="/.test(html), `${file}: CSP blocks inline styling`);
    assert.equal(new Set([...html.matchAll(/\sid="([^"]+)"/g)].map(m => m[1])).size, [...html.matchAll(/\sid="([^"]+)"/g)].length, file);
    for (const [, href] of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
      if (!href.startsWith('/') && !href.startsWith('#')) continue;
      const parsed = new URL(href, `https://www.adport.dev/${file.replace(/\.html$/, '')}`);
      let target = parsed.pathname === '/' ? 'index.html' : parsed.pathname.slice(1);
      if (!path.extname(target)) target += '.html';
      await assert.doesNotReject(access(path.join(site, target)), `${file}: ${href}`);
      if (parsed.hash) {
        const content = target === file ? html : await readFile(path.join(site, target), 'utf8');
        assert(content.includes(`id="${parsed.hash.slice(1)}"`), `${file}: missing fragment ${href}`);
      }
    }
  }
});
