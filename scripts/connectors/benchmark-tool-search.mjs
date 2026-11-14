import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { cases, evaluate, modelDefinitions, readCatalog, role } from './tool-benchmark-fixture.mjs';
import { apiKeyName, runApiBenchmark } from './tool-benchmark-api.mjs';

const { values } = parseArgs({ options: {
  catalogs: { type: 'string' },
  output: { type: 'string' },
  client: { type: 'string', default: 'claude' },
  model: { type: 'string' },
  profile: { type: 'string', multiple: true },
  loading: { type: 'string', multiple: true },
  case: { type: 'string', multiple: true },
} });
const { client } = values;
const keyName = apiKeyName(client);
if (!values.catalogs || !values.output || !['claude', 'codex', 'openai-api', 'claude-api'].includes(client)) {
  throw new Error('Use --catalogs DIR --output DIR --client claude|codex|openai-api|claude-api.');
}
if (keyName && !process.env[keyName]) throw new Error(`Set ${keyName} to run the API benchmark.`);

const profileNames = values.profile ?? ['standard-google-meta', 'full'];
const allowedLoadings = client === 'codex' ? ['default'] : ['eager', 'deferred'];
const loadings = values.loading ?? allowedLoadings;
const selectedCases = values.case ? values.case.map(id => cases.find(test => test.id === id)) : cases;
if (profileNames.some(name => !['standard', 'standard-google-meta', 'full'].includes(name))
    || loadings.some(mode => !allowedLoadings.includes(mode)) || selectedCases.some(test => !test)) {
  throw new Error('Unknown profile, loading mode or case for this client.');
}

const output = resolve(values.output);
const stdio = fileURLToPath(new URL('../../apps/cloud/test/tool-benchmark-stdio.mjs', import.meta.url));
await mkdir(output, { recursive: true });
const scratch = await mkdtemp(join(tmpdir(), 'adport-tool-benchmark-'));
const results = [];

function launch(binary, args, env) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(binary, args, { cwd: scratch, env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code, signal) => resolveRun({ stdout, stderr, code, signal }));
  });
}

function jsonLines(content) {
  return content.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}

async function run(test, catalog, catalogPath, profile, loading) {
  const prefix = join(output, [client, profile, loading, test.id].join('-'));
  const started = performance.now();
  if (keyName) {
    const { responses, ...result } = await runApiBenchmark({ client, model: values.model, loading, catalog, prompt: test.prompt });
    const wallMs = Math.round(performance.now() - started);
    await writeFile(prefix + '.jsonl', responses.map(response => JSON.stringify(response)).join('\n') + '\n');
    const score = evaluate(test, catalog, result.calls, result.answer);
    return { client, profile, loading, case: test.id, tools: catalog.tools.length, wallMs,
      ...result, ...score, passed: !result.error && score.passed };
  }
  const tracePath = prefix + '.calls.jsonl';
  await writeFile(tracePath, '');
  const serverArgs = [stdio, catalogPath, tracePath];
  let invocation;
  if (client === 'claude') {
    const mcpConfig = JSON.stringify({ mcpServers: { adport_fixture: { command: process.execPath, args: serverArgs } } });
    invocation = launch('claude', [
      '-p', '--model', values.model ?? 'sonnet', '--effort', 'low', '--max-turns', '10',
      '--output-format', 'stream-json', '--verbose', '--no-session-persistence',
      '--strict-mcp-config', '--mcp-config', mcpConfig, '--setting-sources', 'project',
      '--disable-slash-commands', '--system-prompt', role,
      '--tools', loading === 'deferred' ? 'ToolSearch' : '',
      '--allowedTools', 'mcp__adport_fixture__*', '--', test.prompt,
    ], { ...process.env, ENABLE_TOOL_SEARCH: loading === 'deferred' ? 'true' : 'false',
      MCP_CONNECTION_NONBLOCKING: '0', DISABLE_TELEMETRY: '1' });
  } else {
    invocation = launch('codex', [
      'exec', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check',
      '--sandbox', 'read-only', '--json', '--disable', 'apps', '--disable', 'plugins', '--disable', 'shell_tool',
      '--enable', 'skip_host_skill_discovery', '-c', 'web_search="disabled"', '-c', 'approval_policy="never"',
      '-c', 'model_reasoning_effort="low"', ...(values.model ? ['-m', values.model] : []),
      '-c', 'mcp_servers.adport_fixture.command=' + JSON.stringify(process.execPath),
      '-c', 'mcp_servers.adport_fixture.args=' + JSON.stringify(serverArgs),
      // The local fixture returns a synthetic preview and rejects apply calls.
      '-c', 'mcp_servers.adport_fixture.tools.google_set_budget.approval_mode="approve"',
      role + '\n\n' + test.prompt,
    ], process.env);
  }
  const { stdout, stderr, code, signal } = await invocation;
  const wallMs = Math.round(performance.now() - started);
  await Promise.all([writeFile(prefix + '.jsonl', stdout), writeFile(prefix + '.stderr', stderr)]);
  const events = jsonLines(stdout);
  const calls = jsonLines(await readFile(tracePath, 'utf8'));
  const result = events.findLast(event => event.type === 'result' || event.type === 'turn.completed');
  const usage = result?.usage ?? {};
  const model = client === 'claude' ? events.find(event => event.type === 'system' && event.subtype === 'init')?.model : values.model;
  const firstUsage = events.find(event => event.type === 'assistant' && event.message?.usage)?.message.usage;
  const sumInput = usage => usage.input_tokens + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
  const answer = result?.result ?? events.findLast(event => event.type === 'item.completed' && event.item.type === 'agent_message')?.item.text ?? '';
  const searchCalls = events.flatMap(event => event.type === 'assistant' ? event.message.content : [])
    .filter(block => block.type === 'tool_use' && block.name === 'ToolSearch').length;
  const failure = events.findLast(event => event.type === 'turn.failed' || event.type === 'error');
  const error = code !== 0 || !result || result.is_error
    ? failure?.error?.message ?? failure?.message ?? result?.result ?? result?.subtype ?? signal ?? `Exit ${code}`
    : undefined;
  const score = evaluate(test, catalog, calls, answer);
  return {
    client, model, profile, loading, case: test.id, tools: catalog.tools.length, wallMs,
    inputTokens: usage.input_tokens === undefined ? undefined : sumInput(usage),
    firstRequestInputTokens: firstUsage ? sumInput(firstUsage) : undefined,
    cachedInputTokens: usage.cached_input_tokens ?? usage.cache_read_input_tokens,
    outputTokens: usage.output_tokens,
    listPriceUsd: result?.total_cost_usd, searchCalls: client === 'claude' ? searchCalls : undefined,
    error, calls, answer, ...score, passed: !error && score.passed,
  };
}

try {
  for (const profile of profileNames) {
    const catalogPath = resolve(values.catalogs, profile + '.json');
    const catalog = readCatalog(catalogPath);
    console.log(JSON.stringify({ profile, tools: catalog.tools.length, wireBytes: catalog.wireBytes,
      modelDefinitionBytes: Buffer.byteLength(JSON.stringify(modelDefinitions(catalog))) }));
    for (const test of selectedCases) {
      for (const loading of loadings) {
        const row = await run(test, catalog, catalogPath, profile, loading);
        results.push(row);
        await writeFile(join(output, client + '-results.json'), JSON.stringify(results, null, 2) + '\n');
        console.log(JSON.stringify({ ...row, calls: row.calls.map(call => call.name), answer: undefined }));
      }
    }
  }
} finally {
  await rm(scratch, { recursive: true, force: true });
}
