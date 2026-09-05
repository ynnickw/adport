export const ADPORT_UI_URI = 'ui://adport/insight-card-v1.html';
export const ADPORT_UI_DOMAIN = 'https://app.adport.dev';

export type AdportView = 'accounts' | 'report' | 'operation' | 'insights';

const providerNames: Record<string, string> = {
  google: 'Google Ads',
  meta: 'Meta Ads',
  tiktok: 'TikTok Ads',
  apple: 'Apple Ads',
  microsoft: 'Microsoft Advertising',
  reddit: 'Reddit Ads',
  snapchat: 'Snapchat Ads',
  spotify: 'Spotify Ads',
  pinterest: 'Pinterest Ads',
  linkedin: 'LinkedIn Ads',
  x: 'X Ads',
  mock: 'Demo',
};

export function viewForTool(name: string, readOnly: boolean): AdportView | undefined {
  if (name === 'accounts_list') return 'accounts';
  if (name === 'report') return 'report';
  if (name === 'audit_run' || name === 'recommendation_dismiss') return 'insights';
  if (!readOnly) return 'operation';
  if (name.startsWith('recommendation') || name.startsWith('audit_')) return 'insights';
  return undefined;
}

export function toolTitle(name: string): string {
  if (name === 'accounts_list') return 'Show connected ad accounts';
  if (name === 'report') return 'Show advertising performance';
  return name
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

export function toolInvocationLabels(view: AdportView): { invoking: string; invoked: string } {
  switch (view) {
    case 'accounts': return { invoking: 'Loading ad accounts…', invoked: 'Ad accounts ready' };
    case 'report': return { invoking: 'Analyzing performance…', invoked: 'Performance ready' };
    case 'operation': return { invoking: 'Checking the proposed change…', invoked: 'Change preview ready' };
    case 'insights': return { invoking: 'Reviewing opportunities…', invoked: 'Opportunities ready' };
  }
}

export function structuredResult(tool: string, view: AdportView, result: unknown): Record<string, unknown> {
  const payload = result && typeof result === 'object' && !Array.isArray(result)
    ? result as Record<string, unknown>
    : { value: result };
  return {
    ...payload,
    _adport: {
      tool,
      view,
      providerNames,
    },
  };
}

/**
 * Self-contained MCP App. It uses the open MCP Apps postMessage protocol and
 * has no network dependencies, which keeps its review CSP intentionally empty.
 */
export const ADPORT_UI_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <meta name="color-scheme" content="light dark" />
  <title>Adport insight</title>
  <style>
    :root {
      --ink: var(--color-text-primary, #171717);
      --muted: var(--color-text-secondary, #6f6f73);
      --faint: var(--color-text-tertiary, #949499);
      --paper: var(--color-background-primary, #ffffff);
      --soft: var(--color-background-secondary, #f6f6f4);
      --line: var(--color-border-secondary, rgba(23,23,23,.11));
      --orange: #ff5a1f;
      --green: #16845b;
      --red: #c8392f;
      --amber: #a86500;
      --radius: var(--border-radius-lg, 18px);
      --sans: var(--font-sans, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
      --mono: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
    }
    * { box-sizing: border-box }
    html, body { margin: 0; min-width: 0; background: transparent; color: var(--ink); font-family: var(--sans) }
    body { padding: 2px; }
    button { font: inherit }
    .shell { overflow: hidden; border: 1px solid var(--line); border-radius: var(--radius); background: var(--paper); box-shadow: 0 10px 32px rgba(20,20,20,.07) }
    .top { display:flex; align-items:center; justify-content:space-between; gap:16px; padding:14px 16px 10px }
    .brand { display:flex; align-items:center; gap:9px; min-width:0 }
    .dot { width:10px; height:10px; border-radius:99px; background:var(--orange); box-shadow:0 0 0 5px color-mix(in srgb,var(--orange) 12%,transparent) }
    .brand b { font-size:12px; letter-spacing:-.02em }
    .context { color:var(--muted); font-size:11px; text-align:right }
    .content { padding:4px 16px 16px }
    .kpis { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:8px; margin-bottom:15px }
    .kpi { min-width:0; padding:12px; border-radius:13px; background:var(--soft); border:1px solid color-mix(in srgb,var(--line) 70%,transparent) }
    button.kpi { cursor:pointer; color:var(--ink); text-align:left }
    button.kpi[aria-pressed="true"] { border-color:color-mix(in srgb,var(--orange) 65%,var(--line)) }
    .kpi small { display:block; color:var(--faint); font:600 9px/1.2 var(--mono); letter-spacing:.11em; text-transform:uppercase }
    .kpi strong { display:block; overflow:hidden; margin-top:8px; font-size:clamp(17px,3vw,24px); line-height:1; letter-spacing:-.04em; text-overflow:ellipsis }
    .panel { min-width:0; padding:13px; border:1px solid var(--line); border-radius:14px }
    .panel-head { display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:12px }
    .panel-head b { font-size:12px }
    .panel-head span { color:var(--faint); font:500 9px/1 var(--mono); text-transform:uppercase; letter-spacing:.1em }
    .bars { display:grid; gap:9px }
    .bar-row { display:grid; grid-template-columns:minmax(100px,1fr) minmax(60px,2fr) auto; align-items:center; gap:9px; font-size:11px }
    .bar-name { display:flex; align-items:center; gap:7px; min-width:0 }
    .bar-name > span:last-child { overflow:hidden; white-space:nowrap; text-overflow:ellipsis }
    .bar-name .logo { width:22px; height:22px; padding:4px; border-radius:6px }
    .track { height:7px; overflow:hidden; border-radius:99px; background:var(--soft) }
    .fill { height:100%; border-radius:99px; background:linear-gradient(90deg,var(--orange),#ff985e) }
    .tabs { display:flex; gap:6px; overflow:auto; padding-bottom:12px }
    .tabs button { flex:0 0 auto; cursor:pointer; padding:8px 12px; border:1px solid var(--line); border-radius:99px; background:var(--paper); color:var(--muted); font-size:12px }
    .tabs button[aria-pressed="true"] { color:var(--ink); border-color:var(--orange); background:color-mix(in srgb,var(--orange) 8%,var(--paper)) }
    button:focus-visible { outline:2px solid var(--orange); outline-offset:2px }
    .notice { padding:10px 12px; margin:0 0 12px; border-radius:10px; background:var(--soft); color:var(--muted); font-size:12px; line-height:1.45 }
    .bar-value { color:var(--muted); font:600 10px/1 var(--mono); white-space:nowrap }
    .list { display:grid; gap:7px }
    .row { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:10px 11px; border:1px solid var(--line); border-radius:12px }
    .identity { display:flex; align-items:center; gap:10px; min-width:0 }
    .logo { display:grid; place-items:center; flex:0 0 auto; width:29px; height:29px; padding:6px; border:1px solid var(--line); border-radius:9px; color:var(--ink); background:var(--paper); font-weight:800; font-size:10px }
    .logo svg { display:block; width:100%; height:100% }
    .logo.reddit { background:#ff4500 }.logo.linkedin { background:#0a66c2 }.logo.spotify { background:#1db954 }.logo.pinterest { background:#e60023 }.logo.x { background:#111 }.logo.snapchat { background:#fffc00;color:#111 }
    .identity-copy { min-width:0 }
    .identity-copy b, .identity-copy span { display:block; overflow:hidden; white-space:nowrap; text-overflow:ellipsis }
    .identity-copy b { font-size:12px }.identity-copy span { margin-top:3px; color:var(--muted); font-size:10px }
    .pill { flex:0 0 auto; padding:5px 8px; border-radius:99px; color:var(--green); background:color-mix(in srgb,var(--green) 10%,transparent); font:700 9px/1 var(--mono); letter-spacing:.08em; text-transform:uppercase }
    .pill.warn { color:var(--amber); background:color-mix(in srgb,var(--amber) 11%,transparent) }
    .pill.danger { color:var(--red); background:color-mix(in srgb,var(--red) 10%,transparent) }
    .pill.neutral { color:var(--muted); background:var(--soft) }
    .operation-name { margin:2px 0 16px; font-size:14px; line-height:1.4; font-weight:600; overflow-wrap:anywhere }
    .comparison { width:100%; border-collapse:collapse; table-layout:fixed; margin-bottom:12px }
    .comparison th { padding:0 8px 8px; color:var(--muted); font-size:10px; font-weight:500; text-align:left }
    .comparison td { border-top:1px solid var(--line); padding:12px 8px; font-size:14px; overflow-wrap:anywhere }
    .comparison td:first-child { color:var(--muted); font-size:11px }
    .comparison td:last-child { font-weight:600 }
    .comparison .changed { color:var(--orange) }
    .adjustment { margin:8px 0; color:var(--amber); font-size:11px; line-height:1.4 }
    details { border-top:1px solid var(--line); padding-top:10px; color:var(--muted); font-size:11px; line-height:1.5 }
    summary { cursor:pointer; width:fit-content; padding:3px 0 }
    summary:focus-visible { outline:2px solid var(--orange); outline-offset:3px }
    details p { margin:8px 0; overflow-wrap:anywhere }
    .empty { padding:26px 12px; text-align:center; color:var(--muted); font-size:12px }
    @media (max-width:620px) { .kpis { grid-template-columns:repeat(2,minmax(0,1fr)) }.top,.content { padding-left:12px; padding-right:12px } }
    @media (max-width:420px) { .bar-row { grid-template-columns:minmax(0,1fr) auto; gap:5px }.bar-name { grid-column:1/-1 }.bar-name > span:last-child { white-space:normal }.bars { gap:12px } }
    @media (prefers-reduced-motion:reduce) { * { animation:none!important; transition:none!important } }
    :root[data-theme="dark"] { --ink:#f5f5f3;--muted:#aaa9ad;--faint:#a09fa5;--paper:#171717;--soft:#222220;--line:rgba(255,255,255,.11) }
    @media (prefers-color-scheme:dark) { :root:not([data-theme="light"]) { --ink:#f5f5f3;--muted:#aaa9ad;--faint:#a09fa5;--paper:#171717;--soft:#222220;--line:rgba(255,255,255,.11) } }
  </style>
</head>
<body>
  <main id="app" class="shell" aria-live="polite">
    <header class="top"><div class="brand"><span class="dot"></span><b>adport.dev</b></div></header>
    <section class="content"><div class="empty">Loading…</div></section>
  </main>
  <script>
  (() => {
    const app = document.getElementById('app');
    const state = { host: {}, result: null, reportGroup: null, reportMetric: 'spend' };
    const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const arr = (value) => Array.isArray(value) ? value : [];
    const num = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
    const money = (value, currency) => currency
      ? new Intl.NumberFormat(state.host.locale || 'en', { style:'currency', currency, maximumFractionDigits:2 }).format(num(value))
      : new Intl.NumberFormat(state.host.locale || 'en', { maximumFractionDigits:2 }).format(num(value));
    const compact = (value) => new Intl.NumberFormat(state.host.locale || 'en', { notation:'compact', maximumFractionDigits:1 }).format(num(value));
    const available = (value) => typeof value === 'number' && Number.isFinite(value);
    const total = (rows, key) => rows.length && rows.every(r => available(r.metrics?.[key])) ? rows.reduce((sum,r) => sum+r.metrics[key],0) : null;
    const currencyOf = (row) => typeof row.currency === 'string' && /^[A-Z]{3}$/.test(row.currency) ? row.currency : null;
    const statusOf = (status) => !status || /unknown|unspecified/i.test(status) ? {label:'Status unavailable',tone:'neutral'} : /disabled|removed|inactive|closed|suspended/i.test(status) ? {label:status,tone:'danger'} : /paused|disable$/i.test(status) ? {label:status,tone:'warn'} : /^(enabled|active|approved)$/i.test(status) ? {label:status,tone:''} : {label:status,tone:'neutral'};
    const notices = (data) => [...arr(data.errors).map(e => (e.provider || 'Provider')+': '+(e.message || 'Read failed')), ...arr(data.warnings).map(e => e.message || 'Some metadata is unavailable'), ...(data.truncated ? ['Partial result: row limit reached. Totals and charts cover returned rows only.'] : [])].map(text => '<p class="notice">'+esc(text)+'</p>').join('');
    const providerName = (id, names) => names?.[id] || String(id || 'Provider');
    const initials = (id) => ({snapchat:'S',spotify:'S',pinterest:'P',linkedin:'in',x:'X'}[id] || String(id || '?').slice(0,2).toUpperCase());
    const providerSvg = {
      // Unmodified official Ghost paths, matching cloud/components/snapchat-logo.tsx.
      snapchat:"<svg viewBox=\"0 0 1024 1024\" aria-hidden=\"true\"> <path fill=\"#fff\" d=\"M992.5,756.3c-4.2-13.9-24.3-23.7-24.3-23.7l0,0c-1.9-1-3.6-1.9-5-2.6c-33.5-16.2-63.2-35.7-88.2-57.8 c-20.1-17.8-37.3-37.4-51.1-58.2c-16.9-25.4-24.8-46.6-28.2-58.1c-1.9-7.5-1.6-10.5,0-14.4c1.3-3.3,5.2-6.4,7-7.9 c11.3-8,29.5-19.8,40.7-27c9.7-6.3,18-11.7,22.9-15.1c15.7-11,26.5-22.2,32.8-34.3c8.2-15.6,9.2-32.8,2.8-49.7 c-8.6-22.8-29.9-36.4-57-36.4c-6,0-12.2,0.7-18.4,2c-15.5,3.4-30.2,8.9-42.5,13.7c-0.9,0.4-1.9-0.3-1.8-1.3 c1.3-30.5,2.8-71.5-0.6-110.4c-3-35.2-10.3-64.9-22.1-90.8c-11.9-26-27.4-45.2-39.5-59.1C708.5,112,688.2,92.5,657.6,75 C614.6,50.4,565.6,37.9,512,37.9c-53.5,0-102.4,12.5-145.5,37.1c-32.4,18.5-53.1,39.4-62.5,50.2c-12.1,13.9-27.6,33.1-39.5,59.1 c-11.9,25.9-19.1,55.5-22.1,90.8c-3.4,39.1-2,76.8-0.6,110.4c0,1-0.9,1.7-1.9,1.3c-12.3-4.8-27-10.3-42.5-13.7 c-6.1-1.3-12.3-2-18.4-2c-27,0-48.3,13.6-57,36.4c-6.4,16.9-5.4,34.1,2.8,49.7c6.4,12.1,17.1,23.3,32.8,34.3 c4.8,3.4,13.2,8.8,22.9,15.1c10.9,7.1,28.6,18.6,40,26.5c1.4,1,6.2,4.6,7.7,8.4c1.6,4,1.9,7-0.2,15c-3.5,11.6-11.4,32.6-28,57.5 c-13.8,20.9-31,40.4-51.1,58.2c-25,22.1-54.7,41.6-88.2,57.8c-1.6,0.8-3.5,1.7-5.5,2.9l0,0c0,0-20,10.2-23.8,23.4 c-5.6,19.5,9.3,37.8,24.4,47.6c24.8,16,55,24.6,72.5,29.3c4.9,1.3,9.3,2.5,13.3,3.7c2.5,0.8,8.8,3.2,11.5,6.7 c3.4,4.4,3.8,9.8,5,15.9v0c1.9,10.3,6.2,23,18.9,31.8c14,9.6,31.7,10.3,54.2,11.2c23.5,0.9,52.7,2,86.2,13.1 c15.5,5.1,29.6,13.8,45.8,23.8c34,20.9,76.3,46.9,148.5,46.9c72.3,0,114.9-26.1,149.1-47.1c16.2-9.9,30.1-18.5,45.3-23.5 c33.5-11.1,62.7-12.2,86.2-13.1c22.5-0.9,40.2-1.5,54.2-11.2c13.6-9.4,17.5-23.4,19.3-33.9c1-5.2,1.6-9.9,4.6-13.7 c2.6-3.3,8.4-5.6,11.1-6.5c4.1-1.3,8.7-2.5,13.8-3.9c17.5-4.7,39.5-10.2,66.2-25.3C993.7,789.8,995.9,767.4,992.5,756.3z\" /> <path fill=\"#000\" d=\"M1020.3,745.5c-7.1-19.4-20.7-29.7-36.1-38.3c-2.9-1.7-5.6-3.1-7.8-4.1c-4.6-2.4-9.3-4.7-14-7.1 c-48.1-25.5-85.7-57.7-111.7-95.8c-8.8-12.9-14.9-24.5-19.2-34c-2.2-6.4-2.1-10-0.5-13.3c1.2-2.5,4.4-5.1,6.2-6.4 c8.3-5.5,16.8-11,22.6-14.7c10.3-6.7,18.5-12,23.7-15.6c19.8-13.8,33.6-28.5,42.2-44.9c12.2-23.1,13.7-49.5,4.3-74.3 c-13-34.4-45.6-55.8-85-55.8c-8.2,0-16.5,0.9-24.7,2.7c-2.2,0.5-4.3,1-6.4,1.5c0.4-23.4-0.2-48.4-2.3-72.8 c-7.4-86-37.5-131.1-68.9-167c-13.1-15-35.9-36.9-70.1-56.5C624.9,21.7,570.9,7.9,512,7.9c-58.7,0-112.7,13.8-160.4,41.1 c-34.4,19.6-57.2,41.6-70.2,56.5c-31.4,35.9-61.5,81-68.9,167c-2.1,24.4-2.6,49.4-2.3,72.8c-2.1-0.5-4.3-1-6.4-1.5 c-8.2-1.8-16.6-2.7-24.7-2.7c-39.4,0-72,21.4-85,55.8c-9.4,24.8-7.9,51.2,4.3,74.3c8.6,16.4,22.5,31.1,42.2,44.9 c5.3,3.7,13.4,9,23.7,15.6c5.6,3.6,13.7,8.9,21.7,14.2c1.2,0.8,5.5,4,7,7c1.7,3.4,1.7,7.1-0.8,13.9c-4.2,9.3-10.3,20.7-18.9,33.3 c-25.5,37.3-62,68.9-108.5,94.1c-24.7,13.1-50.3,21.8-61.1,51.2c-8.2,22.2-2.8,47.5,17.9,68.8l0,0c6.8,7.3,15.4,13.8,26.2,19.8 c25.4,14,47,20.9,64,25.6c3,0.9,9.9,3.1,12.9,5.8c7.6,6.6,6.5,16.6,16.6,31.2c6.1,9.1,13.1,15.3,18.9,19.3 c21.1,14.6,44.9,15.5,70.1,16.5c22.7,0.9,48.5,1.9,77.9,11.6c12.2,4,24.9,11.8,39.5,20.8c35.2,21.7,83.5,51.3,164.2,51.3 c80.8,0,129.3-29.8,164.8-51.5c14.6-8.9,27.2-16.7,39-20.6c29.4-9.7,55.2-10.7,77.9-11.6c25.2-1,48.9-1.9,70.1-16.5 c6.6-4.6,15-12.1,21.6-23.5c7.2-12.3,7.1-21,13.9-26.9c2.8-2.4,8.9-4.5,12.2-5.5c17.1-4.7,39-11.6,64.9-25.9 c11.5-6.3,20.4-13.2,27.5-21.1c0.1-0.1,0.2-0.2,0.3-0.3C1023.4,791.7,1028.3,767.2,1020.3,745.5z M948.6,784 c-43.8,24.2-72.9,21.6-95.5,36.1c-19.2,12.4-7.9,39.1-21.8,48.7c-17.2,11.9-67.9-0.8-133.4,20.8c-54,17.9-88.5,69.2-185.8,69.2 c-97.5,0-131-51.1-185.8-69.2c-65.5-21.6-116.3-8.9-133.4-20.8c-13.9-9.6-2.6-36.3-21.8-48.7c-22.6-14.6-51.7-12-95.5-36.1 c-27.9-15.4-12.1-24.9-2.8-29.4c158.6-76.7,183.8-195.3,185-204.2c1.4-10.6,2.9-19-8.8-29.9c-11.3-10.5-61.6-41.6-75.5-51.3 c-23.1-16.1-33.2-32.2-25.7-52c5.2-13.7,18-18.8,31.5-18.8c4.2,0,8.5,0.5,12.6,1.4c25.3,5.5,49.9,18.2,64.1,21.6 c2,0.5,3.7,0.7,5.2,0.7c7.6,0,10.2-3.8,9.7-12.5c-1.6-27.7-5.6-81.7-1.2-132.2c6-69.4,28.4-103.8,55-134.3 c12.8-14.6,72.8-78,187.5-78c115,0,174.7,63.4,187.5,78c26.6,30.4,49,64.8,55,134.3c4.4,50.5,0.6,104.5-1.2,132.2 c-0.6,9.1,2.2,12.5,9.7,12.5c1.5,0,3.3-0.2,5.2-0.7c14.2-3.4,38.8-16.1,64.1-21.6c4.1-0.9,8.4-1.4,12.6-1.4 c13.5,0,26.3,5.2,31.5,18.8c7.5,19.8-2.7,35.9-25.7,52c-13.9,9.7-64.2,40.8-75.5,51.3c-11.7,10.8-10.2,19.2-8.8,29.9 c1.1,8.9,26.4,127.5,185,204.2C960.6,759.1,976.5,768.6,948.6,784z\" /> </svg>",
      google:'<svg viewBox="0 0 24 24"><path fill="#34a853" d="M4 22.93a4 4 0 1 1 0-8 4 4 0 0 1 0 8Z"/><path fill="#4285f4" d="M23.464 16.929 15.463 3.072A4 4 0 0 0 8.534 7.072l8.001 13.857a4 4 0 0 0 6.929-4Z"/><path fill="#fbbc04" d="M7.514 4.844 1.565 15.148A4.5 4.5 0 0 1 4 14.43a4.5 4.5 0 0 1 4.494 4.715l3.217-5.573-3.61-6.25a4 4 0 0 1-.587-2.478Z"/></svg>',
      meta:'<svg viewBox="0 0 24 24"><path fill="#0866ff" d="M6.915 4.03C2.484 4.03 0 9.95 0 14.449c0 3.37 1.276 5.521 4.439 5.521 2.93 0 4.146-2.574 6.628-6.764l.942-1.664 2.335 3.895c1.883 3.15 3.38 4.533 5.53 4.533 2.788 0 4.126-1.93 4.126-5.56 0-5.53-2.73-10.38-6.8-10.38-2.04 0-3.835 1.53-5.173 3.348C10.16 5.01 8.593 4.03 6.915 4.03Zm-.04 2.606c1.55 0 2.445 1.193 3.908 3.025l-1.02 1.566c-2.22 3.41-3.576 6.155-5.323 6.155-1.23 0-2.154-1.075-2.154-2.9 0-3.755 2.088-7.846 4.588-7.846Zm10.2-.553c2.488 0 4.639 4.054 4.639 8.4 0 1.547-.368 2.899-1.839 2.899-1.193 0-2.027-1.42-4.496-5.362l-1.872-3.008c1.12-1.814 2.248-2.929 3.559-2.929Z"/></svg>',
      tiktok:'<svg viewBox="0 0 58 58"><path fill="#2dccd3" d="M25.98 0v37.68c0 4.94-3.55 8.11-7.88 8.11-1.43 0-2.79-.33-3.97-.95 1.5 1.91 3.87 3.01 6.47 3.01 4.32 0 7.87-3.17 7.87-8.11V2.06h6.85A20.3 20.3 0 0 1 34.87 0h-8.89Z"/><path fill="#f1204a" d="M41.73 11.11a17.48 17.48 0 0 1-4.37-9.05h-2.04c1.16 4.23 3.56 7.18 6.41 9.05Zm7.63 11.37a19.31 19.31 0 0 1-11-2.97c3.84 3.84 8.5 5.03 13.5 5.03v-8.82a17.4 17.4 0 0 1-2.5-.37v7.13Z"/><path fill="currentColor" d="M35.32 2.06h-6.85v37.68c0 4.94-3.55 8.11-7.87 8.11-2.6 0-4.97-1.1-6.47-3.01-2.48-1.29-4.19-3.82-4.19-7.16 0-5.71 4.47-8.71 10.42-8.09v-7.68C10.63 21.93 2.49 29.73 2.49 39.4c0 5.16 2.04 9.71 5.32 12.96 2.89 1.97 6.39 3.11 10.15 3.11 8.69 0 17.91-6.38 17.91-18.41V17.45c.8.8 1.63 1.48 2.49 2.06a19.31 19.31 0 0 0 11 2.97v-7.13a16.14 16.14 0 0 1-7.63-4.24c-2.85-1.87-5.25-4.82-6.41-9.05Z"/></svg>',
      apple:'<svg viewBox="0 0 24 24"><path fill="currentColor" d="M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09Zm3.377-3.065C16.372 2.819 16.929 1.403 16.774 0c-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.56-1.701Z"/></svg>',
      microsoft:'<svg viewBox="0 0 24 24"><path fill="#f25022" d="M0 0h11.4v11.4H0Z"/><path fill="#7fba00" d="M12.6 0H24v11.4H12.6Z"/><path fill="#00a4ef" d="M0 12.6h11.4V24H0Z"/><path fill="#ffb900" d="M12.6 12.6H24V24H12.6Z"/></svg>',
      reddit:'<svg viewBox="0 0 24 24"><path fill="#ff4500" d="M12 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0Zm5.01 4.744c.688 0 1.25.561 1.25 1.249a1.25 1.25 0 0 1-2.498.056l-2.597-.547-.8 3.747c1.824.07 3.48.632 4.674 1.488.308-.309.73-.491 1.207-.491.968 0 1.754.786 1.754 1.754 0 .716-.435 1.333-1.01 1.614.028.169.042.342.042.52 0 2.694-3.13 4.87-7.004 4.87-3.874 0-7.004-2.176-7.004-4.87 0-.183.015-.366.043-.534A1.748 1.748 0 0 1 4.028 12c0-.968.786-1.754 1.754-1.754.463 0 .898.196 1.207.49 1.207-.883 2.878-1.43 4.744-1.487l.885-4.182a.342.342 0 0 1 .378-.239l2.906.617a1.214 1.214 0 0 1 1.108-.701Z"/></svg>'
    };
    const logo = (id) => '<span class="logo '+esc(id)+'" aria-hidden="true">'+(providerSvg[id] || esc(initials(id)))+'</span>';
    const chrome = (body, context) => '<header class="top"><div class="brand"><span class="dot"></span><b>adport.dev</b></div><span class="context">'+esc(context || '')+'</span></header><section class="content">'+body+'</section>';
    function renderAccounts(data, meta) {
      const accounts = arr(data.accounts), errors = arr(data.errors), names = meta.providerNames || {};
      const body = notices(data)+(accounts.length ? '<div class="list">'+accounts.map(a => { const status=statusOf(a.status); return '<div class="row"><div class="identity">'+logo(a.provider)+'<div class="identity-copy"><b>'+esc(a.name || 'Ad account')+'</b><span>'+esc(providerName(a.provider,names))+' · '+esc(a.id)+(a.currency ? ' · '+esc(a.currency) : '')+'</span></div></div><span class="pill '+status.tone+'">'+esc(status.label)+'</span></div>'; }).join('')+'</div>' : '<div class="empty">'+(errors.length ? 'Account inventory could not be fully loaded.' : 'No accessible ad accounts were returned.')+'</div>');
      app.innerHTML = chrome(body, accounts.length+' account'+(accounts.length===1?'':'s'));
    }
    function renderReport(data) {
      const groups = new Map();
      for (const row of arr(data.rows)) {
        const currency=currencyOf(row), key=currency || JSON.stringify([row.provider,row.accountId]);
        if (!groups.has(key)) groups.set(key,{key,currency,label:currency || (row.provider+' · '+row.accountId),rows:[]});
        groups.get(key).rows.push(row);
      }
      const choices=[...groups.values()];
      const selected=groups.get(state.reportGroup) || choices[0];
      const rows=selected?.rows || [], currency=selected?.currency;
      state.reportGroup=selected?.key;
      const tabs=choices.length>1 ? '<div class="tabs" role="group" aria-label="Report currency or account">'+choices.map((g,i)=>'<button data-group="'+i+'" aria-pressed="'+(g===selected)+'">'+esc(g.label)+'</button>').join('')+'</div>' : '';
      const spend=total(rows,'spend'), value=total(rows,'conversion_value');
      const roas=spend>0 && value!==null ? (value/spend).toFixed(2)+'×' : '—';
      const metric=state.reportMetric, labels={spend:'Spend',clicks:'Clicks',conversions:'Conversions',roas:'ROAS'};
      const metricValue=r=>metric==='roas' ? (available(r.metrics?.conversion_value) && r.metrics?.spend>0 ? r.metrics.conversion_value/r.metrics.spend : null) : r.metrics?.[metric];
      const format=value=>metric==='spend'?money(value,currency):metric==='roas'?value.toFixed(2)+'×':compact(value);
      const ranked=[...rows].filter(r=>available(metricValue(r))).sort((a,b)=>metricValue(b)-metricValue(a)).slice(0,6), max=Math.max(1,...ranked.map(metricValue));
      const bars=ranked.length ? ranked.map(r=>'<div class="bar-row"><span class="bar-name" title="'+esc(r.entity?.name || r.entity?.id)+'">'+logo(r.provider)+'<span>'+esc(r.entity?.name || r.entity?.id || 'Entity')+'</span></span><span class="track" aria-hidden="true"><span class="fill" style="display:block;width:'+Math.max(0,metricValue(r)/max*100).toFixed(1)+'%"></span></span><span class="bar-value">'+esc(format(metricValue(r)))+'</span></div>').join('') : '<div class="empty">No '+esc(labels[metric])+' values were returned.</div>';
      const kpi=(key,label,value)=>'<button class="kpi" data-metric="'+key+'" aria-pressed="'+(metric===key)+'" aria-label="Chart '+esc(label)+'"><small>'+esc(label)+'</small><strong>'+esc(value)+'</strong></button>';
      const period=typeof data.date_range==='string' ? data.date_range.replaceAll('_',' ') : data.date_range ? data.date_range.start+' – '+data.date_range.end : 'Selected period';
      const body=notices(data)+tabs+(rows.length ? (!currency?'<p class="notice">Currency unavailable. These values belong to this account only; no cross-account money total is calculated.</p>':'')+'<div class="kpis" role="group" aria-label="Chart metric">'+kpi('spend','Spend',spend===null?'—':money(spend,currency))+kpi('clicks','Clicks',total(rows,'clicks')===null?'—':compact(total(rows,'clicks')))+kpi('conversions','Conversions',total(rows,'conversions')===null?'—':compact(total(rows,'conversions')))+kpi('roas','ROAS',roas)+'</div><div class="panel"><div class="panel-head"><b>'+esc(labels[metric])+'</b><span>Top '+ranked.length+' of '+rows.length+' rows</span></div><div class="bars">'+bars+'</div></div>' : '<div class="empty">'+(arr(data.errors).length?'Report unavailable for the requested providers.':'No rows returned for this period.')+'</div>');
      app.innerHTML=chrome(body,period+(currency?' · '+currency:''));
      app.querySelectorAll('[data-group]').forEach(button=>button.addEventListener('click',()=>{state.reportGroup=choices[Number(button.dataset.group)].key;renderReport(data);}));
      app.querySelectorAll('[data-metric]').forEach(button=>button.addEventListener('click',()=>{state.reportMetric=button.dataset.metric;renderReport(data);}));
    }
    function renderOperation(data, meta) {
      if (meta.tool === 'recommendation_apply' && data.result) data = data.result;
      const preview = data.preview || {}, pending = data.pending_operation_id, applied = data.status === 'applied' || data.applied === true;
      const changes = arr(preview.changes), coercions = arr(preview.coercions), deltas = arr(preview.budgetDeltas);
      const comparisons=deltas.map(v=>({label:(v.target || 'Budget')+' (account units)',before:available(v.fromMicros)?money(v.fromMicros/1e6):'—',after:available(v.toMicros)?money(v.toMicros/1e6):'—'}));
      // Only split provider diff formats with explicit field/value boundaries.
      // Freeform JSON updates stay in details; do not invent previous values.
      for (const change of changes) {
        const match=String(change).match(/^~\s+.+?\s+(status|bidding_strategy)\s+(.*?)\s*→\s*(.+)$/i);
        if (match) comparisons.push({label:match[1].toLowerCase()==='status'?'Status':'Bidding strategy',before:match[2].trim() || '—',after:match[3].trim()});
      }
      const title=String(preview.summary || '').match(/"([^"]+)"/)?.[1] || (comparisons.length ? '' : preview.summary);
      const validation=preview.serverValidated===true?'server validated':preview.serverValidated===false?'local preview · not server validated':'validation not reported';
      const table=comparisons.length?'<table class="comparison" aria-label="Before and after"><thead><tr><th scope="col">Change</th><th scope="col">Before</th><th scope="col">After</th></tr></thead><tbody>'+comparisons.map(v=>'<tr><td>'+esc(v.label)+'</td><td>'+esc(v.before)+'</td><td class="'+(v.before!==v.after?'changed':'')+'">'+esc(v.after)+'</td></tr>').join('')+'</tbody></table>':'<p class="notice">Before/after values were not provided.</p>';
      const body=(title?'<p class="operation-name">'+esc(title)+'</p>':'')+table+coercions.map(v=>'<p class="adjustment">'+esc(v)+'</p>').join('')+'<details><summary>Details</summary><p>'+esc(validation)+'</p><p>'+esc(preview.summary || 'No change details returned.')+'</p>'+changes.map(v=>'<p>'+esc(v)+'</p>').join('')+(pending?'<p>Nothing has been changed. Apply requires the matching pending operation token before it expires.</p>':'')+'<p>'+esc(meta.tool || '')+'</p></details>';
      app.innerHTML = chrome(body, applied?'Applied':pending?'Preview · Not applied':'Result');
    }
    function renderInsights(data) {
      const items = data.finding ? [data.finding] : arr(data.findings || data.recommendations || data.results || data.entries);
      const body = items.length ? '<div class="list">'+items.slice(0,8).map((item,i)=>'<div class="row"><div class="identity"><span class="logo" style="background:var(--orange)">'+(i+1)+'</span><div class="identity-copy"><b>'+esc(item.title || item.summary || item.rule || 'Opportunity')+'</b><span>'+esc(item.description || item.status || item.severity || 'Review recommended')+'</span></div></div><span class="pill '+(/high|critical/i.test(item.severity || '')?'danger':'')+'">'+esc(item.severity || item.status || 'open')+'</span></div>').join('')+'</div>' : '<div class="empty">No active recommendations were returned.</div>';
      app.innerHTML = chrome(body, items.length+' recommendation'+(items.length===1?'':'s'));
    }
    function render(result) {
      let data = result?.structuredContent || result || {};
      if (!data._adport && window.openai?.toolOutput?._adport) data=window.openai.toolOutput;
      const meta = data._adport || {};
      if (result?.isError || data.error) {
        app.innerHTML=chrome('<p class="notice">'+esc(data.message || 'The request could not complete. See the tool response for details.')+'</p>','Request failed');
        return;
      }
      if (meta.view === 'accounts') return renderAccounts(data,meta);
      if (meta.view === 'report') return renderReport(data,meta);
      if (meta.view === 'operation') return renderOperation(data,meta);
      return renderInsights(data,meta);
    }
    const send = (message) => window.parent.postMessage(message,'*');
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => {
      send({jsonrpc:'2.0',method:'ui/notifications/size-changed',params:{height:Math.ceil(document.body.getBoundingClientRect().height)}});
    });
    let id = 1;
    window.addEventListener('message', (event) => {
      if (event.source !== window.parent) return;
      const message = event.data;
      if (!message || message.jsonrpc !== '2.0') return;
      if (message.id === 1 && message.result) {
        state.host = message.result.hostContext || {};
        document.documentElement.dataset.theme = state.host.theme || '';
        send({jsonrpc:'2.0',method:'ui/notifications/initialized'});
        resize?.observe(document.body);
        if (state.result) render(state.result);
      }
      if (message.method === 'ui/notifications/tool-result') { state.result = message.params; render(message.params); }
      if (message.method === 'ui/notifications/host-context-changed') { state.host = {...state.host,...message.params}; document.documentElement.dataset.theme = state.host.theme || ''; if(state.result) render(state.result); }
    });
    send({jsonrpc:'2.0',id:id++,method:'ui/initialize',params:{appInfo:{name:'Adport Insight',version:'1.0.0'},appCapabilities:{},protocolVersion:'2026-01-26'}});
    if (window.openai?.toolOutput) render({structuredContent:window.openai.toolOutput});
  })();
  </script>
</body>
</html>`;
