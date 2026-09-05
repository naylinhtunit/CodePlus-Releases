import test from 'node:test';
import assert from 'node:assert/strict';
import { apiHistory, modelError } from '../public/agent-history.js';
import { providerFixture } from './provider-fixture.mjs';

const tc = { id: 'local_call', name: 'read', arguments: { filePath: 'README.md' }, thought_signature: 'opaque-signature' };
const history = [ { role: 'user', content: 'Read it' }, { role: 'assistant', content: '', provider: 'gemini', model: 'test', tool_calls: [tc] }, { role: 'tool', name: 'read', tool_call_id: tc.id, content: 'Test file' }, { role: 'user', content: 'Hello' } ];
const reply = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

test('every new turn preserves prior tool activity as context but never sends stale live tools', () => {
  const saved = structuredClone(history);
  for (const provider of ['local', 'openai', 'gemini', 'anthropic']) {
    const result = apiHistory(history, provider, 'different');
    assert.ok(result.every(m => !m.tool_calls && m.role !== 'tool'));
    assert.match(JSON.stringify(result), /Test file/);
  }
  const interrupted = apiHistory(history.slice(0, 2), 'gemini', 'test');
  assert.ok(!interrupted.some(m => m.tool_calls));
  assert.deepEqual(history, saved);
  const same = apiHistory(history, 'gemini', 'test');
  assert.ok(same.every(m => !m.tool_calls && m.role !== 'tool'));
  assert.match(same[1].content, /Previous tool activity \(context only/);
});

test('native string and object errors show useful details without keys', () => {
  assert.match(modelError('Gemini HTTP 429: quota exhausted'), /429.*quota/);
  assert.match(modelError('OpenAI HTTP 429: You have no credits remaining.'), /paid OpenAI API model/);
  assert.match(modelError('Anthropic HTTP 400: Your credit balance is too low.'), /requires Anthropic credits/);
  assert.match(modelError('Gemini HTTP 404: models\/gemini-2.5-flash is no longer available to new users.'), /Gemini 3\.6 Flash/);
  assert.equal(modelError({ message: 'bad secret-value' }, ['secret-value']), 'bad [redacted]');
  assert.equal(modelError({ error: 'OpenAI HTTP 401: invalid key' }), 'OpenAI HTTP 401: invalid key');
  assert.doesNotMatch(modelError('https://example.test?key=abc123&other=x sk-example-key'), /abc123|sk-example/);
});

test('Ollama gpt-oss uses medium thinking for agent work and low thinking for chat', () => {
  const api = providerFixture();
  const body = api.ollamaBody('gpt-oss:20b', history);
  assert.equal(body.think, 'medium');
  assert.equal(body.options.num_predict, 8192);
  assert.equal(body.messages[2].tool_name, 'read');
  assert.equal(api.ollamaBody('qwen3:8b', []).think, false);
  assert.equal(api.ollamaBody('gpt-oss:20b', [], false).think, 'low');
  assert.ok(!api.ollamaBody('qwen3:8b', [], false).tools);
  assert.equal(api.parseOllamaReply({ message: { content: '', thinking: '{"name":"write","arguments":{}}' } }), null);
});

test('toolsEnabled false omits tool schemas for local and every cloud protocol', async () => {
  for (const provider of ['local', 'openai', 'gemini', 'anthropic', 'openrouter']) {
    const api = providerFixture(async (_url, options) => {
      const body = JSON.parse(options.body);
      assert.ok(!('tools' in body), `${provider} unexpectedly received tools`);
      assert.ok(!('tool_choice' in body));
      assert.ok(!('toolConfig' in body));
      if (provider === 'local') return reply({ message: { content: 'မင်္ဂလာပါ' } });
      if (provider === 'gemini') return reply({ candidates: [{ content: { parts: [{ text: 'မင်္ဂလာပါ' }] } }] });
      if (provider === 'anthropic') return reply({ content: [{ type: 'text', text: 'မင်္ဂလာပါ' }] });
      return reply({ choices: [{ message: { content: 'မင်္ဂလာပါ' } }] });
    });
    const result = await api.askModel({ provider, model: 'test', messages: [{ role: 'user', content: 'ဟလို' }], apiKey: 'test-only', toolsEnabled: false });
    assert.equal(result.content, 'မင်္ဂလာပါ');
  }
});

test('mutation turns require an initial tool on cloud providers that support forced tool choice', async () => {
  for (const provider of ['openai', 'openrouter', 'gemini', 'anthropic']) {
    const api = providerFixture(async (_url, options) => {
      const body = JSON.parse(options.body);
      if (provider === 'gemini') {
        assert.equal(body.toolConfig.functionCallingConfig.mode, 'ANY');
        return reply({ candidates: [{ content: { parts: [{ functionCall: { name: 'read', args: { filePath: 'README.md' } } }] } }] });
      }
      if (provider === 'anthropic') {
        assert.deepEqual(body.tool_choice, { type: 'any' });
        return reply({ content: [{ type: 'tool_use', id: 'required-call', name: 'read', input: { filePath: 'README.md' } }] });
      }
      assert.equal(body.tool_choice, 'required');
      return reply({ choices: [{ message: { tool_calls: [{ id: 'required-call', function: { name: 'read', arguments: '{"filePath":"README.md"}' } }] } }] });
    });
    const result = await api.askModel({ provider, model: 'test', messages: [{ role: 'user', content: 'Edit the project' }], apiKey: 'test-only', requireTool: true });
    assert.equal(result.tool_calls[0].name, 'read');
  }
});

test('Ollama retries empty replies once, never retries executable tool replies', async () => {
  const requests = [];
  const api = providerFixture(async (_url, options) => { requests.push(JSON.parse(options.body)); return reply({ message: requests.length === 1 ? { content: '', thinking: 'hidden' } : { content: 'Done' } }); });
  assert.equal((await api.askModel({ provider: 'local', model: 'gpt-oss:20b', messages: [] })).content, 'Done');
  assert.equal(requests.length, 2);
  assert.doesNotMatch(JSON.stringify(requests), /hidden/);
  let count = 0;
  const empty = providerFixture(async () => { count++; return reply({ message: { content: '' }, done_reason: 'length' }); });
  await assert.rejects(empty.askModel({ provider: 'local', model: 'gpt-oss:20b', messages: [] }), /one retry.*length/);
  assert.equal(count, 2);
  count = 0;
  const tools = providerFixture(async () => { count++; return reply({ message: { content: '', tool_calls: [{ function: { name: 'read', arguments: '{"filePath":"README.md"}' } }] } }); });
  const result = await tools.askModel({ provider: 'local', model: 'gpt-oss:20b', messages: [] });
  assert.equal(result.tool_calls[0].arguments.filePath, 'README.md');
  assert.equal(count, 1);
});

test('Ollama tools-unsupported fallback keeps thinking mode and has bounded empty recovery', async () => {
  const bodies = [];
  const api = providerFixture(async (_url, options) => { const body = JSON.parse(options.body); bodies.push(body); return body.tools ? reply({ error: 'model does not support tools' }, 400) : reply({ message: { content: 'Hello' } }); });
  await api.askModel({ provider: 'local', model: 'gpt-oss:20b', messages: [] });
  assert.equal(bodies.length, 2); assert.equal(bodies[1].think, 'medium'); assert.ok(!bodies[1].tools);
});

test('Ollama repairs one malformed native tool call through the safe text protocol', async () => {
  const bodies = [];
  const api = providerFixture(async (_url, options) => {
    const body = JSON.parse(options.body); bodies.push(body);
    if (body.tools) return reply({ error: 'error parsing tool call: unexpected end of JSON input' }, 500);
    return reply({ message: { content: '<tool_call>{"name":"read","arguments":{"filePath":"src/app/globals.css"}}</tool_call>' } });
  });
  const result = await api.askModel({ provider: 'local', model: 'gpt-oss:20b', messages: [], toolsEnabled: true });
  assert.equal(bodies.length, 2);
  assert.ok(!bodies[1].tools);
  assert.match(bodies[1].messages.at(-1).content, /previous tool call was malformed/i);
  assert.equal(result.tool_calls[0].arguments.filePath, 'src/app/globals.css');
});

for (const provider of ['openai', 'groq', 'deepseek', 'mistral', 'xai', 'openrouter', 'together', 'fireworks', 'cerebras']) {
  test(`${provider}: tool histories use OpenAI wire format and retain the selected model`, async () => {
    const api = providerFixture(async (_url, options) => {
      const body = JSON.parse(options.body);
      assert.equal(body.model, 'chosen-model');
      assert.equal(body.messages[1].tool_calls[0].function.arguments, JSON.stringify(tc.arguments));
      assert.equal(body.messages[2].tool_call_id, tc.id);
      return reply({ choices: [{ message: { content: 'OK' } }] });
    });
    assert.equal((await api.askModel({ provider, model: 'chosen-model', messages: history, apiKey: 'test-only' })).content, 'OK');
  });
}

test('Gemini keeps thought signatures, groups parallel results, and never puts keys in URLs', async () => {
  const two = structuredClone(history); two[1].tool_calls.push({ ...tc, id: 'second' }); two.splice(3, 0, { ...two[2], tool_call_id: 'second' });
  const api = providerFixture(async (url, options) => {
    assert.ok(!url.includes('key=')); assert.equal(options.headers['x-goog-api-key'], 'test-only');
    const body = JSON.parse(options.body);
    assert.equal(body.contents[1].parts[0].thoughtSignature, tc.thought_signature);
    assert.equal(body.contents[2].parts.filter(p => p.functionResponse).length, 2);
    return reply({ candidates: [{ content: { parts: [{ thought: true, text: 'hidden' }, { functionCall: { name: 'read', args: tc.arguments }, thoughtSignature: 'next-signature' }] } }] });
  });
  const result = await api.askModel({ provider: 'gemini', model: 'test', messages: two, apiKey: 'test-only' });
  assert.equal(result.content, ''); assert.equal(result.tool_calls[0].thought_signature, 'next-signature');
});

test('Anthropic preserves tool use/result and all cloud errors expose HTTP status', async () => {
  const api = providerFixture(async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(body.messages[1].content[0].type, 'tool_use');
    assert.equal(body.messages[2].content[0].type, 'tool_result');
    return reply({ content: [{ type: 'text', text: 'OK' }] });
  });
  assert.equal((await api.askModel({ provider: 'anthropic', model: 'test', messages: history, apiKey: 'test-only' })).content, 'OK');
  for (const provider of ['openai', 'gemini', 'anthropic', 'groq']) {
    const error = providerFixture(async () => reply({ error: { message: 'Quota exceeded' } }, 429));
    await assert.rejects(error.askModel({ provider, model: 'test', messages: [], apiKey: 'test-only' }), /429.*Quota exceeded/);
  }
});
