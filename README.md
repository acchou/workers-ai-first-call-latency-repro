# First Workers AI binding call latency

A standalone reproducer comparing **`env.AI.run()`** with **provider-native HTTPS
through the same Cloudflare AI Gateway**, using the same OpenAI streaming request.
No AI SDK, application services, KV, D1, R2, or application storage operations are involved.

The motivating observation was additional first-call latency through the binding,
without a clear HTTPS advantage on subsequent calls. This repo measures that
comparison; it does not assume a cause or promise a particular latency difference.
The default `gpt-4.1-mini` is an example, not a claim about the original test's model.
Set the model argument to the exact model under investigation.

## Setup and deploy

Requires Node.js 22+, a Cloudflare account supporting Durable Objects, and an
**existing** AI Gateway in the same account. Both paths must use the same provider
credentials: configure an OpenAI BYOK key under the gateway's **`default` alias**,
or use Unified Billing for both. Do not supply a separate OpenAI key on the HTTPS
path. Enable Gateway logging and remove gateway-level retry/fallback/routing rules
that could override this comparison. This code uses a provider model directly.

```sh
npm ci
npx wrangler login
```

Replace `ACCOUNT_ID` and `GATEWAY_ID` in `wrangler.jsonc`. The account ID is the
32-character Cloudflare account ID, not a zone ID. Use the same account when deploying
(set `CLOUDFLARE_ACCOUNT_ID` if your login has multiple accounts).

Create an AI Gateway API token with **AI Gateway: Run** permission for that account.
Store it as `AIG_TOKEN`; it authenticates the HTTPS path. Store a separate random
`BENCHMARK_TOKEN` to protect the benchmark endpoint. Wrangler prompts for each value:

```sh
npm run deploy
npx wrangler secret put AIG_TOKEN
npx wrangler secret put BENCHMARK_TOKEN
```

The benchmark uses real model calls and incurs inference charges. The default is
20 pairs × 2 paths × 3 calls = **120 requests**, with at most 32 output tokens each.
The authenticated endpoint caps each sample at 5 calls. Keep its token private.
Neither secrets nor result files are tracked by Git.

## Run

Set `BENCHMARK_TOKEN` to the same value stored on the Worker. Entering it through
a silent shell prompt avoids putting its literal value into shell history:

```sh
read -s BENCHMARK_TOKEN
export BENCHMARK_TOKEN
npm run benchmark -- https://workers-ai-first-call-latency-repro.YOUR_SUBDOMAIN.workers.dev gpt-4.1-mini 20 3
```

Arguments are Worker URL, bare OpenAI model ID, number of pairs, and calls per object.
Start with `2 2` to verify configuration, then collect a larger run. Use a model
that supports OpenAI Chat Completions, streaming, and `max_completion_tokens`.
This minimal version uses `/chat/completions`, not `/responses`; models that require
the Responses API need a corresponding payload, binding prefix, and parser change.

Each sample runs inside a **new Durable Object dedicated to one path**. The client
alternates binding-first and HTTPS-first pairs, runs sequentially, and does not retry.
Within each object, it performs the requested number of sequential model calls and
fully consumes each response before the next call. A failed call ends that sample;
the runner stops when a pair contains a failed first call and exits unsuccessfully
if any call failed or reported a response-cache hit.

Both paths use:

- The same model, message, streaming options, and output-token cap.
- The same gateway and its stored default BYOK credentials or Unified Billing.
- Gateway response caching bypassed (`skipCache` / `cf-aig-skip-cache`).
- One gateway attempt (`maxAttempts: 1` / `cf-aig-max-attempts: 1`), no SDK or client retries.
- A 60-second per-call abort deadline and Gateway logging with sample metadata.

No `AI.gateway().getUrl()` or other AI-binding call precedes the measurement.
The HTTPS URL is constructed from configuration so it cannot prewarm the binding.
Only the binding and transport differ; the binding may internally normalize the
payload or route it differently, which is part of the path under investigation.

## Results and interpretation

Raw samples and the summary are saved to `results/<timestamp>.json` after every
completed pair. The summary includes first-call and subsequent-call distributions
for each path (sample count, median, nearest-rank p90), plus distributions of
**within-pair first-call differences: binding minus HTTPS**. A positive value means
the binding was slower. Subsequent calls are pooled; inspect raw data for per-object
or per-call analysis. Failed and response-cache-hit calls are excluded.

Timings start immediately before invoking `AI.run()` or `fetch()` inside the DO:

| Field | Meaning |
| --- | --- |
| `headersMs` | Time until the invocation returns a raw `Response` |
| `firstChunkMs` | Time until the first nonempty response-body chunk |
| `firstTextMs` | Time until a complete SSE event with nonempty `choices[].delta.content` |
| `totalMs` | Time until the entire stream is consumed or the call fails |

Role-only events are not text. SSE is decoded across chunk and UTF-8 boundaries.
These measurements exclude client network time and Worker-to-DO admission time.
Workers clocks advance with I/O rather than serving as CPU profilers; timing values
are appropriate for request waits, not for attributing individual setup operations.

Every sample records UTC time, object ID, constructor instance ID, module-level
`isolateId`, and (for binding calls) `bindingIsolateInvocation`. **New DOs do not
guarantee new isolates.** Invocation ordinal 1 identifies the first binding call
observed by this module in that isolate; higher ordinals indicate earlier binding
calls in the same isolate. Inspect these fields before describing results as
fresh-isolate evidence. Infrastructure initialization outside this module is not
observable here, and the benchmark cannot force platform isolate placement.

`ingressColo` / `ingressRay` describe the incoming Worker request, not necessarily
the executing DO's location. Upstream `cf-ray`, `cf-aig-log-id`, `x-request-id`, and
cache status are captured when exposed; the binding's `aiGatewayLogId` supplies its
log ID when transport headers are omitted. Other absent headers remain `null`. Usage events,
including provider cached-token counts when supplied, are retained. **Bypassing
Gateway response caching does not disable provider prompt caching.** Confirm
credential selection, routing, retries, and cache behavior in Gateway logs.

To give Cloudflare useful evidence, share the source, exact model, configuration,
raw JSON, benchmark time window, and Gateway log IDs. Worker observability logs also
contain a `latency-sample` event for each object. Results include your account/gateway
identifiers in the HTTPS URL; review them before publishing. Raw upstream error
bodies and credentials are not included.

## Local checks

```sh
npm test
npm run check
```

Tests exercise SSE framing, UTF-8 boundaries, first-text detection, failure handling,
authentication, request parity, and paired statistics without model calls.
`check` bundles the Worker using a Wrangler deployment dry run. Neither check proves
deployed latency. Run the benchmark on deployed Cloudflare infrastructure; local
`wrangler dev` does not reproduce the real binding, routing, or isolate costs.

## Deployed verification: October 8, 2026

Tested against the `development` gateway with `gpt-4.1-mini`: 20 alternating
pairs, three calls per object, 120 model requests, 18:14–18:17 UTC. The request
arrived through SEA; this is the ingress location, not proof of DO placement.

| Median inside the object | Binding | HTTPS |
| --- | ---: | ---: |
| First call: response headers | 1,821.5 ms | 757.5 ms |
| First call: first text | 1,828.5 ms | 759.5 ms |
| Subsequent calls: first text | 773.5 ms | 773 ms |

The median **within-pair** first-call difference was **+1,033.5 ms to headers**
and **+1,028.5 ms to first text**. This differs from subtracting the two path
medians. The binding was slower in 19 of 20 pairs. All 19 first binding calls
with isolate invocation ordinal 1 were slower; their median first-text difference
was +1,045 ms. The one negative pair reused an isolate with ordinal 4. Subsequent
paired first-text differences had median −22.5 ms (binding minus HTTPS).

Gateway logs were matched to all 120 requests using object/path/call metadata:
all were HTTP 200, uncached, and routed to `openai/gpt-4.1-mini`. All usage events
reported zero provider cached tokens. The penalty appeared in both path orders.
The live run exposed no binding log ID through headers or `aiGatewayLogId`;
Gateway metadata supplied the correlation instead.

This reproduces the reported **first-use latency pattern**, with a larger observed
penalty than the historical +630/+588 ms report. The historical exact model and
payload were not available, so this is an independent reproduction rather than an
exact rerun. It does not identify which binding, routing, or connection operation
causes the delay. Raw results remain under the ignored `results/` directory.

## References

- [Workers binding and third-party models](https://developers.cloudflare.com/ai-gateway/usage/worker-binding-methods/)
- [OpenAI provider-native endpoints](https://developers.cloudflare.com/ai-gateway/usage/providers/openai/)
- [Gateway retry configuration](https://developers.cloudflare.com/ai-gateway/configuration/request-handling/)
- [Gateway authentication](https://developers.cloudflare.com/ai-gateway/configuration/authentication/)
- [Provider credential selection](https://developers.cloudflare.com/ai-gateway/configuration/bring-your-own-keys/)

Delete the dedicated Worker when finished: `npx wrangler delete`.
