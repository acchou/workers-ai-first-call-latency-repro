import { measure } from './measure.mjs';

let isolateId;
let isolateBindingCalls = 0;
const json = (body, status = 200) => Response.json(body, {
  status, headers: { 'cache-control': 'no-store' }
});

export default {
  async fetch(request, env) {
    if (!env.BENCHMARK_TOKEN || request.headers.get('authorization') !== `Bearer ${env.BENCHMARK_TOKEN}`) {
      return json({ error: 'Unauthorized' }, 401);
    }
    if (new URL(request.url).pathname !== '/sample' || request.method !== 'POST') {
      return json({ error: 'Use POST /sample' }, 404);
    }
    if (!/^[a-f0-9]{32}$/i.test(env.ACCOUNT_ID) || !env.GATEWAY_ID || env.GATEWAY_ID.startsWith('REPLACE_') || !env.AIG_TOKEN) {
      return json({ error: 'Configure ACCOUNT_ID, GATEWAY_ID and AIG_TOKEN first' }, 503);
    }
    let config;
    try { config = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
    const { path, model = 'gpt-4.1-mini', calls = 3 } = config;
    if (!['binding', 'https'].includes(path) || !Number.isInteger(calls) || calls < 1 || calls > 5 ||
        typeof model !== 'string' || !/^[a-zA-Z0-9._-]{1,100}$/.test(model)) {
      return json({ error: 'Expected path binding|https, calls 1..5, and a bare OpenAI model ID' }, 400);
    }
    // One new object for one path. Neither path can warm the other's object.
    const id = env.SAMPLES.newUniqueId();
    const forwarded = new Request('https://sample.internal/', {
      method: 'POST', body: JSON.stringify({ path, model, calls, objectId: id.toString(),
        ingressRay: request.headers.get('cf-ray'), ingressColo: request.cf?.colo ?? null })
    });
    return env.SAMPLES.get(id).fetch(forwarded);
  }
};

export class LatencySample {
  constructor(_ctx, env) {
    isolateId ??= crypto.randomUUID();
    this.env = env;
    this.instanceId = crypto.randomUUID();
    this.used = false;
  }
  async fetch(request) {
    if (this.used) return json({ error: 'A sample object may only run once' }, 409);
    this.used = true;
    const config = await request.json();
    const { path, model, calls } = config;
    const env = this.env;
    const endpoint = `https://gateway.ai.cloudflare.com/v1/${env.ACCOUNT_ID}/${encodeURIComponent(env.GATEWAY_ID)}/openai/chat/completions`;
    const payload = {
      model, messages: [{ role: 'user', content: 'Reply with exactly these words: Hello from this latency test.' }],
      stream: true, stream_options: { include_usage: true }, max_completion_tokens: 32
    };
    const results = [];
    for (let call = 1; call <= calls; call++) {
      const metadata = { repro: 'workers-ai-first-call-latency', objectId: config.objectId, path, call };
      const headers = {
        'content-type': 'application/json',
        'cf-aig-skip-cache': 'true', 'cf-aig-max-attempts': '1',
        'cf-aig-collect-log': 'true', 'cf-aig-metadata': JSON.stringify(metadata)
      };
      const bindingIsolateInvocation = path === 'binding' ? ++isolateBindingCalls : null;
      const invoke = path === 'binding'
        ? () => env.AI.run(`openai/${model}`, payload, {
            returnRawResponse: true,
            gateway: { id: env.GATEWAY_ID, skipCache: true, collectLog: true,
              retries: { maxAttempts: 1 }, metadata },
            extraHeaders: headers, signal: AbortSignal.timeout(60000)
          })
        : () => fetch(endpoint, {
            method: 'POST', headers: { ...headers, 'cf-aig-authorization': `Bearer ${env.AIG_TOKEN}` },
            body: JSON.stringify(payload), signal: AbortSignal.timeout(60000)
          });
      const timing = await measure(invoke);
      if (path === 'binding') {
        // The binding can omit transport headers while exposing the log ID here.
        timing.trace['cf-aig-log-id'] ??= env.AI.aiGatewayLogId ?? null;
      }
      results.push({ call, bindingIsolateInvocation, ...timing });
      // A failed first invocation still changes initialization state. Do not label
      // any following call as a successful first-call sample.
      if (!timing.ok) break;
    }
    const sample = { ...config, isolateId, instanceId: this.instanceId,
      gatewayId: env.GATEWAY_ID, endpoint, payload, responseCache: 'bypassed', maxAttempts: 1, results };
    console.log(JSON.stringify({ event: 'latency-sample', ...sample }));
    return json(sample);
  }
}
