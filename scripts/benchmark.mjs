import { mkdir, writeFile } from 'node:fs/promises';
import { summarize } from './stats.mjs';

const [baseUrl, model = 'gpt-4.1-mini', pairsArg = '20', callsArg = '3'] = process.argv.slice(2);
const token = process.env.BENCHMARK_TOKEN;
const count = Number(pairsArg);
const calls = Number(callsArg);
if (!baseUrl || !token || !Number.isInteger(count) || count < 1 || count > 100 ||
    !Number.isInteger(calls) || calls < 1 || calls > 5) {
  console.error('Usage: BENCHMARK_TOKEN=... npm run benchmark -- <worker-url> [model] [pairs:1..100] [calls:1..5]');
  process.exit(1);
}
const url = new URL('/sample', baseUrl);
if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) {
  throw new Error('Use HTTPS for deployed Workers');
}
const run = { startedAt: new Date().toISOString(), workerUrl: url.origin, model, calls,
  methodology: 'Separate new DOs per path; alternating path order; sequential samples; no client retries', pairs: [] };
await mkdir('results', { recursive: true });
const filename = `results/${run.startedAt.replace(/[:.]/g, '-')}.json`;
async function save() {
  await writeFile(filename, JSON.stringify({ ...run, summary: summarize(run.pairs) }, null, 2) + '\n');
}
for (let index = 0; index < count; index++) {
  const pair = { index: index + 1, order: index % 2 ? ['https', 'binding'] : ['binding', 'https'] };
  for (const path of pair.order) {
    const response = await fetch(url, { method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ path, model, calls }), signal: AbortSignal.timeout(calls * 60000 + 30000) });
    if (!response.ok) throw new Error(`Sample endpoint returned HTTP ${response.status}; completed pairs saved to ${filename}`);
    pair[path] = await response.json();
    if (pair[path].path !== path || !Array.isArray(pair[path].results)) throw new Error('Invalid sample response');
  }
  run.pairs.push(pair);
  await save();
  const a = pair.binding.results[0];
  const b = pair.https.results[0];
  console.error(`Pair ${index + 1}/${count}: first text binding=${a.firstTextMs ?? 'failed'} ms https=${b.firstTextMs ?? 'failed'} ms`);
  if (!a.ok || !b.ok) {
    console.error(`Stopping after failed invocation; inspect ${filename} and Worker/Gateway logs.`);
    break;
  }
}
const summary = summarize(run.pairs);
console.log(JSON.stringify({ file: filename, summary }, null, 2));
if (summary.failedOrCachedCalls.length) process.exitCode = 1;
