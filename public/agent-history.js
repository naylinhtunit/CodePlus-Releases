// Keep the visible transcript intact. Only adapt the copy sent to an API.
export function apiHistory(messages, provider, model) {
  const result = [];
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (message.error || message.stopped) continue;
    const content = String(message.content ?? '');
    if (message.tool_calls?.length) {
      const calls = message.tool_calls;
      const results = [];
      while (messages[i + 1]?.role === 'tool') results.push(messages[++i]);
      // A new user turn must never resume stale tool calls. Keep prior activity as
      // compact context; only calls added to the current request are executable.
      result.push({ role: 'assistant', content: [
        content,
        'Previous tool activity (context only; do not continue unless the latest user request asks for it):',
        ...calls.map(call => `${call.name} ${JSON.stringify(call.arguments ?? {})}`),
        ...results.map(item => `${item.name || 'Tool'} result: ${String(item.content ?? '').slice(0, 2000)}`)
      ].filter(Boolean).join('\n') });
    } else if (message.role === 'tool') {
      result.push({ role: 'assistant', content: `Previous tool result (context only): ${content}` });
    } else if (content.trim()) {
      result.push({ role: message.role, content });
    }
  }
  if (provider !== 'local') return result;

  // Keep small local models responsive by bounding old conversation and tool
  // summaries. Live tool results from the current turn are appended separately.
  const budget = 12_000;
  const compact = [];
  let used = 0;
  for (let i = result.length - 1; i >= 0; i--) {
    const message = result[i];
    const remaining = budget - used;
    if (remaining <= 0) break;
    const content = String(message.content || '');
    const keep = content.length <= remaining ? content : content.slice(-remaining);
    compact.unshift({ ...message, content: keep });
    used += keep.length;
  }
  return compact;
}

export function modelError(error, secrets = []) {
  const nested = error?.error;
  let message = typeof error === 'string'
    ? error
    : error?.message || (typeof nested === 'string' ? nested : nested?.message) || 'The model request failed. Check your connection and provider settings.';
  message = String(message);
  for (const secret of secrets) if (secret) message = message.split(secret).join('[redacted]');
  message = message.replace(/([?&](?:key|api_key)=)[^\s&"']+/gi, '$1[redacted]').replace(/\b(?:sk-[\w-]+|AIza[\w-]+)\b/g, '[redacted]');
  if (/OpenAI HTTP 429/i.test(message) && /credits|quota|billing/i.test(message)) {
    message += '\n\nThis is a paid OpenAI API model. Add API credits or choose a provider/model with an available free tier.';
  } else if (/Anthropic HTTP (?:400|402|429)/i.test(message) && /credit|balance|billing|quota/i.test(message)) {
    message += '\n\nClaude API usage requires Anthropic credits. Add credits or choose another provider.';
  } else if (/Gemini HTTP 404/i.test(message) && /gemini-2\.5-flash|no longer available/i.test(message)) {
    message += '\n\nCodePlus will migrate this saved legacy selection to Gemini 3.6 Flash. Open provider settings and save/refresh the model if needed.';
  }
  return message;
}
