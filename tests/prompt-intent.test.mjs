import test from 'node:test';
import assert from 'node:assert/strict';
import { casualHistory, promptNeedsTools, promptRequestsMutation } from '../public/prompt-intent.js';

test('greetings and ordinary conversation never enable workspace tools', () => {
  for (const prompt of ['ဟလို', 'ဟလို 👋', 'Hello!', 'နေကောင်းလား', 'ကျေးဇူးတင်ပါတယ်', 'こんにちは']) {
    assert.equal(promptNeedsTools(prompt), false, prompt);
  }
  assert.equal(promptNeedsTools('What is React?'), false);
});

test('explicit workspace work and attached files enable agent tools', () => {
  assert.equal(promptNeedsTools('Please fix the button in src/app/page.tsx'), true);
  assert.equal(promptNeedsTools('Pls set “View docs” button width like “Start building”.'), true);
  assert.equal(promptNeedsTools('“View docs” button ရဲ့ width ကို “Start building” button width အတိုင်းထားပေးပါ'), true);
  assert.equal(promptNeedsTools('docs page ကို ဖန်တီးပြီး button ကို ပြင်ပေးပါ'), true);
  assert.equal(promptNeedsTools('Make it prettier', { previousMode: 'agent' }), true);
  assert.equal(promptNeedsTools('summarize this', { hasAttachments: true }), true);
  assert.equal(promptNeedsTools('Continue'), true);
});

test('workspace mutation requests are distinguished from explanations and preserve-only requests', () => {
  assert.equal(promptRequestsMutation('Pls set “View docs” button width like “Start building”.'), true);
  assert.equal(promptRequestsMutation('button width ကို တူအောင် ပြင်ပေးပါ'), true);
  assert.equal(promptRequestsMutation('Explain this file'), false);
  assert.equal(promptRequestsMutation('Inspect the current project but do not change any file'), false);
});

test('casual history contains only chat-mode messages and no stale tool transcript', () => {
  const messages = [
    { role: 'user', mode: 'agent', content: 'Fix it' },
    { role: 'assistant', mode: 'agent', content: '', tool_calls: [{ id: '1', name: 'read' }] },
    { role: 'tool', content: 'secret workspace text' },
    { role: 'user', mode: 'chat', content: 'ဟလို' },
    { role: 'assistant', mode: 'chat', content: 'မင်္ဂလာပါ' }
  ];
  assert.deepEqual(casualHistory(messages), [
    { role: 'user', content: 'ဟလို' },
    { role: 'assistant', content: 'မင်္ဂလာပါ' }
  ]);
});
