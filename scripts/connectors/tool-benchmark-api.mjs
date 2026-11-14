import { fixtureResult, modelDefinitions, role } from './tool-benchmark-fixture.mjs';

const hosts = {
  'openai-api': { url: 'https://api.openai.com/v1/responses', key: 'OPENAI_API_KEY', model: 'gpt-6-astra' },
  'claude-api': { url: 'https://api.anthropic.com/v1/messages', key: 'ANTHROPIC_API_KEY', model: 'claude-sonnet-5-5' },
};

export function apiKeyName(client) {
  return hosts[client]?.key;
}

export async function runApiBenchmark({ client, model, loading, catalog, prompt, request = fetch }) {
  const host = hosts[client];
  const openai = client === 'openai-api';
  const deferred = loading === 'deferred';
  model ??= host.model;
  const tools = modelDefinitions(catalog).map(({ name, description, schema }) => ({
    ...(openai ? { type: 'function', parameters: schema, strict: false } : { input_schema: schema }),
    name, description, ...(deferred ? { defer_loading: true } : {}),
  }));
  if (deferred) tools.unshift(openai ? { type: 'tool_search' } : {
    type: 'tool_search_tool_bm25_20251119', name: 'tool_search_tool_bm25',
  });
  const key = process.env[host.key];
  const headers = openai
    ? { authorization: 'Bearer ' + key }
    : { 'x-api-key': key, 'anthropic-version': '2023-06-01' };
  const calls = [];
  const responses = [];
  const system = [role, catalog.instructions].filter(Boolean).join('\n\n');
  const messages = [{ role: 'user', content: prompt }];
  const totals = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, searchCalls: 0 };
  let firstRequestInputTokens;
  let answer = '';
  let error;
  let input = prompt;
  let previousResponseId;

  function invoke(name, args) {
    calls.push({ name, args });
    return fixtureResult(catalog, name, args);
  }

  for (let turn = 0; turn < 10; turn++) {
    const body = openai
      ? { model, instructions: system, tools, input, parallel_tool_calls: false, max_output_tokens: 2048,
          ...(previousResponseId ? { previous_response_id: previousResponseId } : {}) }
      : { model, system, tools, messages, max_tokens: 2048 };
    let response;
    let result;
    try {
      response = await request(host.url, {
        method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(120_000),
      });
      result = await response.json();
    } catch (failure) {
      error = failure.message;
      break;
    }
    responses.push(result);
    if (!response.ok) {
      error = `HTTP ${response.status}: ${result.error?.message ?? 'request failed'}`;
      break;
    }
    const usage = result.usage;
    const inputTokens = usage.input_tokens + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
    firstRequestInputTokens ??= inputTokens;
    totals.inputTokens += inputTokens;
    totals.cachedInputTokens += usage.input_tokens_details?.cached_tokens ?? usage.cache_read_input_tokens ?? 0;
    totals.outputTokens += usage.output_tokens;
    model = result.model ?? model;
    if (openai) {
      previousResponseId = result.id;
      if (result.status !== 'completed') {
        error = result.error?.message ?? result.incomplete_details?.reason ?? result.status;
        break;
      }
      totals.searchCalls += result.output.filter(item => item.type === 'tool_search_call').length;
      input = result.output.filter(item => item.type === 'function_call').map(item => ({
        type: 'function_call_output', call_id: item.call_id,
        output: JSON.stringify(invoke(item.name, JSON.parse(item.arguments))),
      }));
      if (input.length) continue;
      answer = result.output.flatMap(item => item.content ?? []).filter(item => item.type === 'output_text').map(item => item.text).join('\n');
      break;
    }
    totals.searchCalls += result.content.filter(item => item.type === 'server_tool_use' && item.name.startsWith('tool_search_tool')).length;
    messages.push({ role: 'assistant', content: result.content });
    const outputs = result.content.filter(item => item.type === 'tool_use').map(item => {
      const value = invoke(item.name, item.input);
      return { type: 'tool_result', tool_use_id: item.id, content: JSON.stringify(value),
        ...(value.error ? { is_error: true } : {}) };
    });
    if (outputs.length) {
      messages.push({ role: 'user', content: outputs });
      continue;
    }
    if (result.stop_reason === 'pause_turn') continue;
    answer = result.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
    if (result.stop_reason !== 'end_turn') error = result.stop_reason;
    break;
  }
  if (!answer && !error) error = 'No final response within the benchmark turn limit';
  return { model, calls, responses, answer, error, firstRequestInputTokens, ...totals };
}
