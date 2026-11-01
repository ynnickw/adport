import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { withSupport } from './website-support.mjs';

const site = fileURLToPath(new URL('../../website/', import.meta.url));
const files = (await readdir(site, { recursive: true })).filter(file => file.endsWith('.html'));

test('support is available exactly once on every public page with accessible local assets', async () => {
  for (const file of files) {
    const html = await readFile(path.join(site, file), 'utf8');
    assert.equal(withSupport(html), html, file);
    assert.equal((html.match(/class="site-support-launcher"/g) ?? []).length, 1, file);
    assert.equal((html.match(/id="site-support-dialog"/g) ?? []).length, 1, file);
    assert.equal((html.match(/src="\/support.js"/g) ?? []).length, 1, file);
    assert.equal((html.match(/href="\/support.css"/g) ?? []).length, 1, file);
    assert(html.includes('href="mailto:yannick@adport.dev?subject=Adport%20support"'), file);
    const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
    assert.equal(new Set(ids).size, ids.length, file);
    for (const [, refs] of html.matchAll(/(?:aria-labelledby|aria-controls|for)="([^"]+)"/g)) {
      for (const id of refs.split(' ')) assert(ids.includes(id), `${file}: ${id}`);
    }
  }
  for (const asset of ['support.js', 'support.css', 'yannick-support.png']) await access(path.join(site, asset));
  assert((await readFile(path.join(site, 'yannick-support.png'))).equals(await readFile(new URL('../../apps/cloud/public/yannick-support.png', import.meta.url))));
});

test('support decoration is idempotent and preserves existing page content', () => {
  const original = '<!doctype html><html><head><title>Example</title></head><body><main>Hello</main></body></html>';
  const result = withSupport(original);
  assert.equal(withSupport(result), result);
  assert(result.includes('<title>Example</title>'));
  assert(result.includes('<main>Hello</main>'));
});

test('the public form uses a same-origin endpoint and a documented reply email', async () => {
  const settings = JSON.parse(await readFile(path.join(site, 'vercel.json'), 'utf8'));
  assert(settings.rewrites.some(r => r.source === '/api/support' && r.destination === 'https://app.adport.dev/api/public-support'));
  const privacy = await readFile(path.join(site, 'privacy.html'), 'utf8');
  assert(privacy.includes('id="support-messages"'));
  assert(privacy.includes('Resend'));
});

test('public pages send Cloud visitors to the waitlist until launch', async () => {
  for (const file of files) {
    const html = await readFile(path.join(site, file), 'utf8');
    for (const [, href] of html.matchAll(/href="([^"]+)"/g)) {
      const target = new URL(href.replaceAll('&amp;', '&'), 'https://www.adport.dev');
      assert.notEqual(target.hostname, 'app.adport.dev', `${file}: private Cloud link ${href}`);
    }
    if (file === 'index.html' || file === 'pricing.html') {
      const actions = [...html.matchAll(/<a class="pricing-action\b[^"]*" href="([^"]+)"[^>]*>([^<]+)<\/a>/g)]
        .filter(([, href]) => !href.startsWith('mailto:'));
      assert.equal(actions.length, file === 'index.html' ? 4 : 8, file);
      for (const [, href, label] of actions) {
        assert.equal(href, '/#waitlist', file);
        assert.equal(label, 'Join the waitlist', file);
      }
      assert(!html.includes('data-plan='), `${file}: pricing must not rewrite waitlist links`);
    }
  }
});
