import test from 'node:test';
import assert from 'node:assert/strict';
import { measure, sseParser } from '../src/measure.mjs';
import { distribution, summarize } from '../scripts/stats.mjs';
import worker, { LatencySample } from '../src/worker.mjs';
import { modelConfig } from '../src/model.mjs';

function anthropicResponse() {
  const events = [
    { type: 'message_start', message: { model: 'claude-haiku-4-5-20251001', usage: { input_tokens: 20,
      cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1 } } },
    { type: 'content_block_start', content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'ignore' } },
    { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hi 🌎' } },
    { type: 'message_delta', usage: { output_tokens: 4 } },
    { type: 'message_stop' }
  ];
  const bytes = new TextEncoder().encode(events.map(event =>
    `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
  return new Response(new ReadableStream({ start(controller) {
    for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
    controller.close();
  } }), { headers: { 'content-type': 'text/event-stream' } });
}

test('Anthropic first text ignores start/thinking events and merges cumulative usage', async () => {
  let time = 0;
  const result = await measure(async () => anthropicResponse(), () => ++time);
  assert.equal(result.ok, true);
  assert.equal(result.streamFormat, 'anthropic-messages');
  assert.equal(result.responseModel, 'claude-haiku-4-5-20251001');
  assert.equal(result.textCharacters, 'Hi 🌎'.length);
  assert.ok(result.firstTextMs > result.firstChunkMs);
  assert.deepEqual(result.usage, { input_tokens: 20, cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0, output_tokens: 4 });
});

test('model selection preserves bare OpenAI IDs and rejects unimplemented providers', () => {
  assert.deepEqual(modelConfig('gpt-4.1-mini'), modelConfig('openai/gpt-4.1-mini'));
  for (const model of ['google/gemini', 'anthropic/../../private', '', null]) {
    assert.throws(() => modelConfig(model));
  }
});

test('Anthropic binding and HTTPS share native payload and capture the Worker version', async () => {
  let bindingCall, httpsCall;
  const env = { ACCOUNT_ID: 'a'.repeat(32), GATEWAY_ID: 'test-gateway', AIG_TOKEN: 'secret',
    VERSION: { id: 'test-version' }, AI: { async run(...args) {
      bindingCall = args; return anthropicResponse();
    } } };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (...args) => { httpsCall = args; return anthropicResponse(); };
  try {
    for (const path of ['binding', 'https']) {
      const object = new LatencySample({}, env);
      const response = await object.fetch(new Request('https://internal/', { method: 'POST',
        body: JSON.stringify({ path, model: 'anthropic/claude-haiku-4-5', calls: 1, objectId: 'anthropic-object' }) }));
      const sample = await response.json();
      assert.equal(sample.results[0].ok, true);
      assert.equal(sample.workerVersion, 'test-version');
    }
  } finally { globalThis.fetch = originalFetch; }
  assert.equal(bindingCall[0], 'anthropic/claude-haiku-4.5');
  assert.equal(bindingCall[1].model, 'claude-haiku-4-5-20251001');
  assert.deepEqual(bindingCall[1], JSON.parse(httpsCall[1].body));
  assert.equal(bindingCall[1].max_tokens, 32);
  assert.ok(!('stream_options' in bindingCall[1]));
  assert.equal(bindingCall[2].extraHeaders['anthropic-version'], '2023-06-01');
  assert.equal(httpsCall[1].headers['anthropic-version'], '2023-06-01');
  assert.equal(httpsCall[1].headers['cf-aig-skip-cache'], 'true');
  assert.equal(httpsCall[1].headers['cf-aig-max-attempts'], '1');
  assert.ok(!('x-api-key' in httpsCall[1].headers));
  assert.ok(httpsCall[0].endsWith('/anthropic/v1/messages'));
});

function streamResponse() {
  const fragments = [
    'data: {"choices":[{"delta":{"role":"assistant"}}]}\r\n\r',
    '\ndata: {"choices":[{"delta":{"content":"Hi ' ,
    '🌎"}}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens_details":{"cached_tokens":0}}}\n\n',
    'data: [DONE]\n\n'
  ];
  const bytes = new TextEncoder().encode(fragments.join(''));
  // Split every byte to exercise UTF-8 and SSE delimiter boundaries.
  return new Response(new ReadableStream({ start(controller) {
    for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
    controller.close();
  } }), { headers: { 'content-type': 'text/event-stream', 'cf-aig-log-id': 'test-log' } });
}

test('SSE framing survives split CRLF and joins multiple data lines', () => {
  const events = [];
  const parse = sseParser(value => events.push(value));
  parse('data: {"x":\r');
  parse('\ndata: 1}\r\n\r');
  parse('\n');
  parse('data: [DONE]\n\n');
  assert.deepEqual(events, [{ x: 1 }]);
});

test('first text excludes role-only events and retains usage and request IDs', async () => {
  let time = 0;
  const result = await measure(async () => streamResponse(), () => ++time);
  assert.equal(result.ok, true);
  assert.ok(result.headersMs <= result.firstChunkMs);
  assert.ok(result.firstTextMs > result.firstChunkMs);
  assert.equal(result.textCharacters, 'Hi 🌎'.length);
  assert.equal(result.usage.prompt_tokens_details.cached_tokens, 0);
  assert.equal(result.trace['cf-aig-log-id'], 'test-log');
});

test('HTTP errors, malformed SSE, error events, and text-free streams fail', async () => {
  for (const response of [
    new Response('private provider error', { status: 429 }),
    new Response('data: broken\n\n', { headers: { 'content-type': 'text/event-stream' } }),
    new Response('data: {"error":{"message":"private upstream data"}}\n\n', { headers: { 'content-type': 'text/event-stream' } }),
    new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
  ]) {
    const result = await measure(async () => response);
    assert.equal(result.ok, false);
    assert.equal(result.firstTextMs, null);
    assert.ok(!JSON.stringify(result).includes('private'));
  }
});

test('endpoint refuses unauthenticated calls before allocating objects', async () => {
  let allocations = 0;
  const response = await worker.fetch(new Request('https://example.com/sample', { method: 'POST' }),
    { BENCHMARK_TOKEN: 'secret', SAMPLES: { newUniqueId() { allocations++; } } });
  assert.equal(response.status, 401);
  assert.equal(allocations, 0);
});

test('binding and HTTPS use identical payload, gateway, caching, and attempt settings', async () => {
  let bindingCall, httpsCall;
  const env = { ACCOUNT_ID: 'a'.repeat(32), GATEWAY_ID: 'test-gateway', AIG_TOKEN: 'secret',
    AI: { aiGatewayLogId: 'binding-log', async run(...args) {
      bindingCall = args;
      const response = streamResponse();
      response.headers.delete('cf-aig-log-id');
      return response;
    } } };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (...args) => { httpsCall = args; return streamResponse(); };
  try {
    for (const path of ['binding', 'https']) {
      const object = new LatencySample({}, env);
      const response = await object.fetch(new Request('https://internal/', { method: 'POST',
        body: JSON.stringify({ path, model: 'gpt-4.1-mini', calls: 1, objectId: 'test-object' }) }));
      const sample = await response.json();
      assert.equal(sample.results[0].ok, true);
      assert.equal(sample.results[0].trace['cf-aig-log-id'], path === 'binding' ? 'binding-log' : 'test-log');
      assert.equal((await object.fetch(new Request('https://internal/'))).status, 409);
    }
  } finally { globalThis.fetch = originalFetch; }
  assert.equal(bindingCall[0], 'openai/gpt-4.1-mini');
  assert.deepEqual(bindingCall[1], JSON.parse(httpsCall[1].body));
  assert.equal(bindingCall[2].returnRawResponse, true);
  assert.equal(bindingCall[2].gateway.id, 'test-gateway');
  assert.equal(bindingCall[2].gateway.skipCache, true);
  assert.equal(bindingCall[2].gateway.retries.maxAttempts, 1);
  assert.equal(httpsCall[1].headers['cf-aig-skip-cache'], 'true');
  assert.equal(httpsCall[1].headers['cf-aig-max-attempts'], '1');
  assert.equal(httpsCall[0], `https://gateway.ai.cloudflare.com/v1/${'a'.repeat(32)}/test-gateway/openai/chat/completions`);
});

test('paired median is computed from within-pair differences; failures/cache hits excluded', () => {
  const result = (value, call = 1) => ({ ok: true, call, firstTextMs: value, headersMs: value,
    firstChunkMs: value, totalMs: value, trace: {} });
  const pairs = [
    { index: 1, binding: { results: [result(100), result(3, 2)] }, https: { results: [result(90)] } },
    { index: 2, binding: { results: [result(200)] }, https: { results: [result(1)] } },
    { index: 3, binding: { results: [result(300)] }, https: { results: [result(250)] } },
    { index: 4, binding: { results: [{ ...result(999), ok: false }] }, https: { results: [result(2)] } },
    { index: 5, binding: { results: [{ ...result(999), trace: { 'cf-aig-cache-status': 'HIT' } }] }, https: { results: [result(2)] } }
  ];
  const summary = summarize(pairs);
  assert.equal(summary.pairedFirstBindingMinusHttps.firstTextMs.median, 50);
  assert.equal(summary.pairedFirstBindingMinusHttps.firstTextMs.n, 3);
  assert.equal(summary.binding.first.firstTextMs.n, 3);
  assert.equal(summary.binding.subsequent.firstTextMs.median, 3);
  assert.equal(summary.failedOrCachedCalls.length, 2);
  assert.deepEqual(distribution([]), { n: 0, median: null, p90: null });
  assert.equal(distribution([2, 4]).median, 3);
});
