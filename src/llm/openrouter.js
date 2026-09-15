// Talking to OpenRouter.
//
// One key, every model. Replies stream back token by token so the story
// appears as it is written rather than arriving in a lump.

const ENDPOINT = 'https://openrouter.ai/api/v1';

export class ModelError extends Error {
  constructor(message, { status, code, retryable = false } = {}) {
    super(message);
    this.name = 'ModelError';
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

/** Turn a provider failure into something worth showing a person. */
function explain(status, body) {
  const raw = body?.error?.message || body?.message || '';
  switch (status) {
    case 401:
      return new ModelError('That API key was not accepted. Check it in Settings.', { status, code: 'bad_key' });
    case 402:
      return new ModelError('Your OpenRouter balance has run out. Top it up and try again.', { status, code: 'no_credit' });
    case 403:
      if (/moderat/i.test(raw)) {
        return new ModelError('This model refused the request. Try a different model for this scene.', { status, code: 'refused' });
      }
      return new ModelError(raw || 'The provider refused this request.', { status, code: 'forbidden' });
    case 408:
    case 504:
      return new ModelError('The model took too long to answer. Try again.', { status, code: 'timeout', retryable: true });
    case 429:
      return new ModelError('Too many requests just now. Wait a moment and try again.', { status, code: 'rate_limit', retryable: true });
    case 502: case 503:
      return new ModelError('The model provider is having trouble. Try again, or switch model.', { status, code: 'upstream', retryable: true });
    default:
      if (status >= 500) return new ModelError('The model provider failed. Try again.', { status, code: 'server', retryable: true });
      return new ModelError(raw || `The request failed (${status}).`, { status, code: 'unknown' });
  }
}

/**
 * Send a prompt and stream the reply.
 *
 * @param {object}   opts
 * @param {string}   opts.apiKey
 * @param {string}   opts.model
 * @param {object[]} opts.messages
 * @param {function} opts.onDelta   called with each new piece of text
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{text, usage, model, provider, finishReason}>}
 */
export async function stream({
  apiKey, model, messages,
  temperature = 0.95, maxTokens = 1200, topP = 1,
  frequencyPenalty = 0, presencePenalty = 0,
  topK = 0, minP = 0, topA = 0, repetitionPenalty = 0,
  provider = null, reasoning = null,
  onDelta = () => {}, signal,
}) {
  const body = {
    model,
    messages: messages.map(({ role, content }) => ({ role, content })),
    stream: true,
    temperature,
    max_tokens: maxTokens,
    top_p: topP,
    usage: { include: true },
  };
  if (frequencyPenalty) body.frequency_penalty = frequencyPenalty;
  if (presencePenalty) body.presence_penalty = presencePenalty;
  // Sent only when set to something meaningful. Whether the company serving
  // the model applies them is theirs to decide: measured on one, top_p bit
  // and top_k and min_p were ignored entirely.
  if (topK > 0) body.top_k = topK;
  if (minP > 0 && minP < 1) body.min_p = minP;
  if (topA > 0) body.top_a = topA;
  if (repetitionPenalty > 0 && repetitionPenalty !== 1) body.repetition_penalty = repetitionPenalty;
  if (provider) body.provider = provider;
  // Reasoning costs money and, on the models we use, measurably lowers how
  // willingly they follow instructions. Off unless asked for.
  if (reasoning) body.reasoning = reasoning;
  else body.reasoning = { enabled: false };

  let res;
  try {
    res = await fetch(`${ENDPOINT}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'http://localhost',
        'X-Title': 'Tipsy',
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new ModelError('Could not reach the model. Check your internet connection.', { code: 'network', retryable: true });
  }

  if (!res.ok) {
    let parsed = null;
    try { parsed = await res.json(); } catch { /* body was not json */ }
    throw explain(res.status, parsed);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let usage = null;
  let finishReason = null;
  let usedModel = model;
  let usedProvider = null;

  try {
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // Events are separated by a blank line. Anything after the last one is a
    // partial event and must wait for more bytes.
    const events = buffer.split('\n\n');
    buffer = events.pop() ?? '';

    for (const event of events) {
      for (const line of event.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;

        let parsed;
        try { parsed = JSON.parse(data); } catch { continue; }

        if (parsed.error) throw explain(parsed.error.code || 500, parsed);
        if (parsed.model) usedModel = parsed.model;
        if (parsed.provider) usedProvider = parsed.provider;
        if (parsed.usage) usage = parsed.usage;

        const choice = parsed.choices?.[0];
        if (!choice) continue;
        if (choice.finish_reason) finishReason = choice.finish_reason;
        const piece = choice.delta?.content;
        if (piece) { text += piece; onDelta(piece); }
      }
    }
  }

  } catch (e) {
    // A stopped reply is still a reply. Hand back what arrived before the
    // stop, so the caller can keep it rather than throw it away.
    if (e.name === 'AbortError') e.partial = text;
    throw e;
  }

  return { text, usage, model: usedModel, provider: usedProvider, finishReason };
}

/** Everything OpenRouter can serve, trimmed to what this app needs to know. */
export async function listModels(apiKey) {
  const res = await fetch(`${ENDPOINT}/models`, {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
  });
  if (!res.ok) throw explain(res.status, null);
  const { data } = await res.json();
  return data.map((m) => ({
    id: m.id,
    name: m.name,
    context: m.context_length,
    promptPrice: Number(m.pricing?.prompt || 0) * 1e6,
    completionPrice: Number(m.pricing?.completion || 0) * 1e6,
    cachePrice: Number(m.pricing?.input_cache_read || 0) * 1e6,
    moderated: !!m.top_provider?.is_moderated,
    free: m.id.endsWith(':free'),
  }));
}

export async function credits(apiKey) {
  const res = await fetch(`${ENDPOINT}/credits`, { headers: { Authorization: `Bearer ${apiKey}` } });
  if (!res.ok) throw explain(res.status, null);
  const { data } = await res.json();
  return {
    purchased: Number(data.total_credits || 0),
    used: Number(data.total_usage || 0),
    remaining: Number(data.total_credits || 0) - Number(data.total_usage || 0),
  };
}
