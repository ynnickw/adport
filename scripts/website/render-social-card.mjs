// Render the social card as HTML using the site's wordmark, font, and provider assets.
// Preview at 1200 × 630 and capture to website/og-image.png after a branding change.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const home = readFileSync(resolve(root, 'website/index.html'), 'utf8');
const wordmark = home.match(/<span class="domain-wordmark">[\s\S]*?<\/span><\/span>/)?.[0];
const providerStrip = home.match(/<ul class="logo-strip"[^>]*>([\s\S]*?)<\/ul>/)?.[1];
const logos = [...(providerStrip ?? '').matchAll(/<svg[\s\S]*?<\/svg>/g)].map(match => match[0]);
if (!wordmark || logos.length !== 11) throw new Error('Shared wordmark or provider logos missing.');
const font = readFileSync(resolve(root, 'website/fonts/overpass-latin-wght-normal.woff2')).toString('base64');
const mono = readFileSync(resolve(root, 'website/fonts/overpass-mono-latin-wght-normal.woff2')).toString('base64');
const html = `<!doctype html><html lang="en"><meta charset="utf-8"><title>Adport social card</title><style>
@font-face{font-family:Overpass;src:url(data:font/woff2;base64,${font});font-weight:100 900}
@font-face{font-family:Mono;src:url(data:font/woff2;base64,${mono});font-weight:300 700}
*{box-sizing:border-box}html,body{margin:0;width:1200px;height:630px;overflow:hidden}
body{font-family:Overpass,sans-serif;background:#f5f5f7;color:#1d1d1f;border-bottom:8px solid #ff6b00}
.brand{position:absolute;top:58px;left:64px;font-size:30px;font-weight:800;letter-spacing:-.035em}.brand span span{color:#ff6b00}
h1{position:absolute;top:138px;left:64px;margin:0;font-size:64px;line-height:1.04;letter-spacing:-.035em;font-weight:800}h1 span{color:#8e8e93}
.description{position:absolute;top:371px;left:64px;width:625px;font-size:23px;line-height:1.4;margin:0;color:#48484a}
.providers{position:absolute;bottom:40px;left:64px;display:flex;align-items:center;gap:22px}.providers svg{height:26px;width:26px;fill:currentColor}
.google-logo path:nth-child(1){fill:#34a853}.google-logo path:nth-child(2){fill:#4285f4}.google-logo path:nth-child(3){fill:#fbbc04}.meta-logo{fill:#0866ff!important}.reddit-logo{fill:#ff4500!important}.linkedin-logo{fill:#0a66c2!important}.spotify-logo{fill:#1ed760!important}.pinterest-logo{fill:#e60023!important}.microsoft-logo path:nth-child(1){fill:#f25022}.microsoft-logo path:nth-child(2){fill:#7fba00}.microsoft-logo path:nth-child(3){fill:#00a4ef}.microsoft-logo path:nth-child(4){fill:#ffb900}
.frame{position:absolute;left:752px;top:121px;width:392px;height:396px;padding:22px;border:1px solid #d8d8df;border-radius:28px}.ticket{background:white;border:1px solid #d8d8df;border-radius:16px;box-shadow:0 12px 24px #00000012;overflow:hidden}
.ticket-main{padding:18px}.preview{display:flex;align-items:center;gap:6px;font-size:12px;font-weight:700}.dot{width:8px;height:8px;border-radius:50%;background:#ff6b00;box-shadow:0 0 0 5px #ff6b0015}.tool{margin-left:auto;font-family:Mono,monospace;font-size:10px;font-weight:400;color:#6e6e73}
.campaign{font-size:17px;font-weight:700;margin:18px 0 4px}.budget{font-size:38px;font-weight:750;letter-spacing:-.04em}.previous{font-size:23px;color:#6e6e73;text-decoration:line-through}.arrow{font-size:26px;color:#6e6e73;font-weight:400}.rules{display:grid;gap:9px;margin-top:16px;font-size:14px}.rule{display:flex;gap:8px;align-items:center}.check{display:inline-grid;place-items:center;width:18px;height:18px;background:#e6f4eb;color:#16804a;border-radius:50%;font-size:13px;font-weight:700}
.ticket-foot{border-top:2px dashed #d8d8df;padding:16px 18px 18px}.meta{display:flex;justify-content:space-between;font-size:11px;color:#6e6e73}.value{display:flex;justify-content:space-between;font-family:Mono,monospace;font-size:14px;margin-top:3px}.approval{background:linear-gradient(90deg,#ff6b00 58%,#1d1d1f 58%);height:50px;border-radius:30px;text-align:center;padding:13px;font-weight:700;font-size:15px;margin-top:16px;color:#000}
</style><body><div class="brand">${wordmark}</div><h1>Your agent proposes.<br>You see the diff.<br><span>Then it runs.</span></h1><p class="description">Manage 11 ad platforms from Claude, ChatGPT or<br>Cursor. Every write is previewed, capped and logged.</p><div class="providers">${logos.join('')}</div><div class="frame"><div class="ticket"><div class="ticket-main"><div class="preview"><span class="dot"></span>Preview, not applied<span class="tool">google_set_budget</span></div><p class="campaign">Brand Search US daily budget</p><div class="budget"><span class="previous">$40.00</span> <span class="arrow">→</span> $48.00</div><div class="rules"><div class="rule"><span class="check">✓</span>Account is not protected</div><div class="rule"><span class="check">✓</span>+20.0% is inside the 25% cap</div></div></div><div class="ticket-foot"><div class="meta"><span>pending_operation_id</span><span>Expires in</span></div><div class="value"><span>7c41e9b2-5d0a-4f6e…</span><span>14:58</span></div><div class="approval">Hold to approve</div></div></div></div></body></html>`;
const destination = process.argv[2];
if (!destination) throw new Error('Pass an output HTML path.');
writeFileSync(destination, html);
console.log('Rendered social card HTML.');
