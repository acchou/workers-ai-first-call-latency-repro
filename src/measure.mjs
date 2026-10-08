// Split SSE events across arbitrary transport chunks, including CRLF boundaries.
export function sseParser(onEvent) {
  let buffer = '';
  return (chunk, final = false) => {
    buffer += chunk;
    let match;
    while ((match = /\r?\n\r?\n/.exec(buffer))) {
      const event = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      emit(event);
    }
    if (final && buffer.trim()) {
      emit(buffer);
      buffer = '';
    }
  };
  function emit(event) {
    const data = event.split(/\r?\n/).filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).replace(/^ /, '')).join('\n');
    if (data && data !== '[DONE]') onEvent(JSON.parse(data));
  }
}

export async function measure(invoke, now = () => performance.now()) {
  const startedAt = new Date().toISOString();
  const start = now();
  const result = {
    startedAt, ok: false, headersMs: null, firstChunkMs: null, firstTextMs: null,
    totalMs: null, status: null, trace: {}, usage: null, textCharacters: 0
  };
  try {
    const response = await invoke();
    result.headersMs = now() - start;
    if (!(response instanceof Response)) throw new Error('Binding did not return a raw Response');
    result.status = response.status;
    for (const name of ['cf-ray', 'cf-aig-log-id', 'cf-aig-cache-status', 'x-request-id', 'content-type']) {
      result.trace[name] = response.headers.get(name);
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Upstream HTTP ${response.status}`);
    }
    if (!response.headers.get('content-type')?.includes('text/event-stream')) {
      await response.body?.cancel();
      throw new Error('Expected a text/event-stream response');
    }
    if (!response.body) throw new Error('Missing streaming body');
    const parse = sseParser(event => {
      if (event.error) throw new Error('Upstream error event');
      if (event.usage) result.usage = event.usage;
      for (const choice of event.choices ?? []) {
        const text = choice.delta?.content;
        if (typeof text === 'string' && text.length) {
          result.firstTextMs ??= now() - start;
          result.textCharacters += text.length;
        }
      }
    });
    const decoder = new TextDecoder();
    const reader = response.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value.length) result.firstChunkMs ??= now() - start;
        parse(decoder.decode(value, { stream: true }));
      }
      parse(decoder.decode(), true);
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    if (result.firstTextMs === null) throw new Error('Stream completed without text');
    result.ok = true;
  } catch (error) {
    // Do not serialize raw upstream bodies/errors, which can contain credentials.
    result.error = error instanceof Error && /^(Upstream HTTP|Expected|Missing|Stream completed|Binding did)/.test(error.message)
      ? error.message : 'Invocation or stream parsing failed; inspect Worker/Gateway logs';
  }
  result.totalMs = now() - start;
  return result;
}
