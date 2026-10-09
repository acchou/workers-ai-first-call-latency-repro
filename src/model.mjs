// Bare model IDs retain the original OpenAI CLI behavior. Other providers must
// be explicit so an unsupported family cannot silently take the wrong route.
export function modelConfig(value) {
  if (typeof value !== 'string') throw new Error('Invalid model');
  const match = /^(?:(openai|anthropic)\/)?([a-zA-Z0-9._-]{1,100})$/.exec(value);
  if (!match) throw new Error('Use a bare OpenAI model ID or openai|anthropic/model');
  const provider = match[1] ?? 'openai';
  // Cloudflare's binding catalog and Anthropic's Messages API use different
  // identifiers for Haiku 4.5. Pin the native request to the dated snapshot and
  // verify responseModel on both paths rather than sending an invalid alias.
  const haiku = provider === 'anthropic' &&
    ['claude-haiku-4.5', 'claude-haiku-4-5', 'claude-haiku-4-5-20251001'].includes(match[2]);
  const model = haiku ? 'claude-haiku-4-5-20251001' : match[2];
  const bindingModel = `${provider}/${haiku ? 'claude-haiku-4.5' : model}`;
  const payload = {
    model, messages: [{ role: 'user', content: 'Reply with exactly these words: Hello from this latency test.' }],
    stream: true,
    ...(provider === 'anthropic' ? { max_tokens: 32 }
      : { stream_options: { include_usage: true }, max_completion_tokens: 32 })
  };
  return { provider, model, bindingModel, payload,
    endpointPath: provider === 'anthropic' ? 'anthropic/v1/messages' : 'openai/chat/completions',
    headers: provider === 'anthropic' ? { 'anthropic-version': '2023-06-01' } : {} };
}
