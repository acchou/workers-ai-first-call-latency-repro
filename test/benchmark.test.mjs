import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('CLI alternates paths and writes raw samples and paired summaries without its token', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'latency-repro-test-'));
  const requests = [];
  const server = createServer(async (request, response) => {
    assert.equal(request.headers.authorization, 'Bearer cli-test-token');
    let body = '';
    for await (const chunk of request) body += chunk;
    const config = JSON.parse(body);
    requests.push(config);
    const base = config.path === 'binding' ? 120 : 20;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ ...config, objectId: String(requests.length), results:
      Array.from({ length: config.calls }, (_, index) => ({ call: index + 1, ok: true,
        firstTextMs: base, firstChunkMs: base - 5, headersMs: base - 10, totalMs: base + 10, trace: {} })) }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../scripts/benchmark.mjs', import.meta.url)),
      `http://127.0.0.1:${server.address().port}`, 'gpt-4.1-mini', '2', '2'], {
      cwd: directory, env: { ...process.env, BENCHMARK_TOKEN: 'cli-test-token' }, stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const code = await new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('exit', resolve);
    });
    assert.equal(code, 0, stderr);
    assert.deepEqual(requests.map(r => r.path), ['binding', 'https', 'https', 'binding']);
    const output = JSON.parse(stdout);
    const raw = await readFile(join(directory, output.file), 'utf8');
    const report = JSON.parse(raw);
    assert.equal(report.pairs.length, 2);
    assert.equal(report.summary.pairedFirstBindingMinusHttps.firstTextMs.median, 100);
    assert.equal(report.summary.binding.subsequent.firstTextMs.n, 2);
    assert.ok(!raw.includes('cli-test-token'));
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
