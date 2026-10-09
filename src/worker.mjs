import { measure } from './measure.mjs';
import { modelConfig } from './model.mjs';

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
    if (!['binding', 'https'].includes(path) || !Number.isInteger(calls) || calls < 1 || calls > 5) {
      return json({ error: 'Expected path binding|https and calls 1..5' }, 400);
    }
    try { modelConfig(model); } catch { return json({ error: 'Use a bare OpenAI model ID or openai|anthropic/model' }, 400); }
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
    const { provider, bindingModel, endpointPath, payload, headers: providerHeaders } = modelConfig(model);
    const endpoint = `https://gateway.ai.cloudflare.com/v1/${env.ACCOUNT_ID}/${encodeURIComponent(env.GATEWAY_ID)}/${endpointPath}`;
    const results = [];
    for (let call = 1; call <= calls; call++) {
      const metadata = { repro: 'workers-ai-first-call-latency', objectId: config.objectId, path, call };
      const headers = {
        ...providerHeaders,
        'content-type': 'application/json',
        'cf-aig-skip-cache': 'true', 'cf-aig-max-attempts': '1',
        'cf-aig-collect-log': 'true', 'cf-aig-metadata': JSON.stringify(metadata)
      };
      const bindingIsolateInvocation = path === 'binding' ? ++isolateBindingCalls : null;
      const invoke = path === 'binding'
        ? () => env.AI.run(bindingModel, payload, {
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
    const sample = { ...config, provider, bindingModel, workerVersion: env.VERSION?.id ?? null,
      isolateId, instanceId: this.instanceId,
      gatewayId: env.GATEWAY_ID, endpoint, payload, responseCache: 'bypassed', maxAttempts: 1, results };
    console.log(JSON.stringify({ event: 'latency-sample', ...sample }));
    return json(sample);
  }
}
