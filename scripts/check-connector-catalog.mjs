import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const providers = new Set(['google', 'meta', 'tiktok', 'apple', 'microsoft', 'reddit', 'snapchat', 'spotify', 'pinterest', 'linkedin', 'x']);

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  }
  return value;
}

/** Compare complete SDK tools/list exports, never credentials or tool results. */
export function checkConnectorCatalog(production, review, approvedProviders) {
  const errors = [];
  const approved = new Set(approvedProviders);
  if (!approved.size || [...approved].some(provider => !providers.has(provider))) {
    errors.push('Specify the explicitly verified production provider IDs. An empty or unknown provider list is not accepted.');
  }
  function readCatalog(value, label) {
    const result = value?.result ?? value;
    if (!result || !Array.isArray(result.tools) || result.tools.length === 0 || result.nextCursor) {
      errors.push(`${label}: expected a nonempty, complete tools/list export (collect all pages first).`);
      return new Map();
    }
    if (result.data_source === 'synthetic') errors.push(`${label}: synthetic provenance is not production evidence.`);
    const catalog = new Map();
    for (const tool of result.tools) {
      if (!tool || typeof tool.name !== 'string' || !/^[a-z][a-z0-9_]*$/.test(tool.name)) {
        errors.push(`${label}: invalid tool name.`);
        continue;
      }
      if (catalog.has(tool.name)) errors.push(`${label}: duplicate tool ${tool.name}.`);
      catalog.set(tool.name, tool);
      if (/^(demo|mock|synthetic)_/.test(tool.name)) errors.push(`${label}: non-production tool ${tool.name}.`);
      const provider = tool.name.split('_')[0];
      if (providers.has(provider) && !approved.has(provider)) {
        errors.push(`${label}: ${tool.name} belongs to a provider outside the verified release scope.`);
      }
      if (typeof tool.description !== 'string' || !tool.description.trim() || tool.inputSchema?.type !== 'object') {
        errors.push(`${label}: ${tool.name} lacks a description or object input schema.`);
      }
      for (const hint of ['readOnlyHint', 'destructiveHint', 'openWorldHint']) {
        if (typeof tool.annotations?.[hint] !== 'boolean') errors.push(`${label}: ${tool.name} lacks explicit ${hint}.`);
      }
    }
    for (const provider of approved) {
      if (![...catalog.keys()].some(name => name.startsWith(`${provider}_`))) {
        errors.push(`${label}: missing native ${provider} tools.`);
      }
    }
    return catalog;
  }
  const live = readCatalog(production, 'Production');
  const scanned = readCatalog(review, 'Review');
  for (const [name, tool] of live) {
    if (!scanned.has(name)) errors.push(`Review: missing production tool ${name}.`);
    else if (JSON.stringify(canonical(tool)) !== JSON.stringify(canonical(scanned.get(name)))) {
      errors.push(`Review: metadata differs for ${name} (including schemas, annotations and UI/security metadata).`);
    }
  }
  for (const name of scanned.keys()) {
    if (!live.has(name)) errors.push(`Review: tool ${name} is absent from production.`);
  }
  return { ok: errors.length === 0, errors, productionTools: live.size, reviewTools: scanned.size };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [productionPath, reviewPath, providerIds, ...extra] = process.argv.slice(2);
  if (!productionPath || !reviewPath || !providerIds || extra.length) {
    console.error('Usage: node scripts/check-connector-catalog.mjs <production-tools.json> <review-tools.json> <verified-provider-ids-comma-separated>');
    process.exitCode = 2;
  } else {
    try {
      const result = checkConnectorCatalog(JSON.parse(readFileSync(productionPath, 'utf8')), JSON.parse(readFileSync(reviewPath, 'utf8')), providerIds.split(',').map(value => value.trim()));
      for (const error of result.errors) console.error(error);
      console.log(`Catalog ${result.ok ? 'matches' : 'BLOCKED'}: production=${result.productionTools}, review=${result.reviewTools}.`);
      console.log('Metadata parity only: OAuth refresh, provider approval, account isolation and real host/tool execution still require independent evidence.');
      process.exitCode = result.ok ? 0 : 1;
    } catch {
      console.error('Could not read valid tools/list JSON exports. Do not supply credentials or tool results.');
      process.exitCode = 2;
    }
  }
}
