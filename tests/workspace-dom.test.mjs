import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { renderWorkspace, listen } from '../public/workspace-dom.js';

const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
function fixture(desktop = false, appSource = source) {
  const { document, Event } = new JSDOM('<html><body><div id="app"></div></body></html>').window;
  const frames = [];
  const sandbox = {
    document, Event, console, URL, structuredClone, renderWorkspace, listen,
    window: desktop ? { __TAURI_INTERNALS__: { invoke: async () => [] } } : {},
    location: { pathname: '/app', hostname: 'localhost' },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    setTimeout: () => 1, clearTimeout() {}, requestAnimationFrame: callback => frames.push(callback),
  };
  vm.createContext(sandbox);
  vm.runInContext(appSource.slice(0, appSource.lastIndexOf('\napp();')).replace(/^import .*;\r?\n/gm, '') + '\nthis.ui = { state, app, chatHistoryStorageKey, rememberProject, activateMemoryProject, createProjectFile };', sandbox);
  const { state, app } = sandbox.ui;
  Object.assign(state, { customPreview: true, previewUrl: 'http://localhost:3000/', localModelsLoaded: true });
  const render = () => { app(); while (frames.length) frames.shift()(); };
  render();
  return { document, Event, state, app, render, frames, root: document.querySelector('#app'), ui: sandbox.ui };
}

test('Projects sidebar retains project folders and gives every project a separate chat key', async () => {
  const f = fixture();
  const firstId = f.state.activeProjectId;
  const firstChatKey = f.ui.chatHistoryStorageKey();
  const second = f.ui.rememberProject({ id:'memory:second', kind:'memory', name:'Second project' });
  await f.ui.activateMemoryProject(second, { 'README.md':'# Second\n' });
  assert.equal(f.state.projects.length, 2);
  assert.equal(f.state.activeProjectId, second.id);
  assert.notEqual(f.ui.chatHistoryStorageKey(), firstChatKey);
  assert.equal(f.root.querySelectorAll('[data-project-id]').length, 2);
  assert.equal(f.root.querySelector('.side-heading span').textContent, 'PROJECTS');
  assert.ok(f.root.querySelector('#projects-add'));
  assert.equal(f.root.querySelector('#workspaces'), null);
  assert.equal(f.state.projects.some(project => project.id === firstId), true);
  assert.equal(f.root.querySelector('.workspace-card'), null);
  assert.equal(f.root.querySelector('#export-project'), null);
});

test('active project and nested folders expand only when clicked', () => {
  const f = fixture();
  const project = f.root.querySelector(`[data-project-id="${f.state.activeProjectId}"]`);
  assert.ok(f.root.querySelector('.project-files'));
  assert.ok(f.root.querySelector('[data-folder="src"]'));
  assert.equal(f.root.querySelector('[data-folder="src/app"]'), null);
  f.root.querySelector('[data-folder="src"]').click();
  assert.ok(f.root.querySelector('[data-folder="src/app"]'));
  assert.equal(f.root.querySelector('[data-file="src/app/page.tsx"]'), null);
  f.root.querySelector('[data-folder="src/app"]').click();
  assert.ok(f.root.querySelector('[data-file="src/app/page.tsx"]'));
  project.click();
  assert.equal(f.root.querySelector('.project-files'), null);
  f.root.querySelector(`[data-project-id="${f.state.activeProjectId}"]`).click();
  assert.ok(f.root.querySelector('.project-files'));
});

for (const desktop of [false, true]) {
  test(`${desktop ? 'desktop' : 'web'}: project file button uses the in-app create dialog`, async () => {
    const f = fixture(desktop);
    f.root.querySelector('#new-file').click();
    const input = f.root.querySelector('#new-file-path');
    assert.ok(input);
    input.value = `src/platform-${desktop ? 'desktop' : 'web'}.ts`;
    await f.ui.createProjectFile({ preventDefault() {} });
    assert.equal(f.state.newFileOpen, false);
    assert.equal(f.state.active, input.value);
    assert.equal(f.state.files[input.value], '// New file\n');
  });
}

for (const desktop of [false, true]) {
  test(`${desktop ? 'desktop' : 'web'}: Explorer changes preserve preview, chat and draft`, () => {
    const f = fixture(desktop), frame = f.root.querySelector('.preview-frame');
    const chat = f.root.querySelector('#chat'), prompt = f.root.querySelector('#prompt');
    const ancestors = []; for (let node = frame; node !== f.root; node = node.parentNode) ancestors.push(node);
    prompt.value = 'Keep my unsent prompt';
    prompt.dispatchEvent(new f.Event('input'));
    chat.scrollTop = 120;
    f.root.querySelector('[data-folder="src"]').click();
    f.root.querySelector('[data-folder="src/app"]').click();
    for (const file of ['README.md', 'src/app/globals.css', 'src/app/page.tsx']) {
      f.root.querySelector(`[data-file="${file}"]`).click();
      assert.equal(f.state.active, file);
      assert.equal(f.root.querySelector('#code').value, f.state.files[file]);
      assert.equal(f.root.querySelector('.preview-frame'), frame);
      assert.ok(ancestors.every(node => node.isConnected));
      assert.equal(f.root.querySelector('#chat'), chat);
      assert.equal(chat.scrollTop, 120);
      assert.equal(f.root.querySelector('#prompt'), prompt);
      assert.equal(prompt.value, 'Keep my unsent prompt');
    }
    assert.doesNotMatch(source, /moveBefore|replaceWith\(existingPreviewFrame\)/);
  });
}

test('test harness supports Windows CRLF checkouts', () => {
  const f = fixture(true, source.replace(/\r?\n/g, '\r\n'));
  f.root.querySelector('[data-file="README.md"]').click();
  assert.equal(f.state.active, 'README.md');
});

test('chat/settings/layout updates preserve editor draft, cursor and scroll', () => {
  const f = fixture(), code = f.root.querySelector('#code'), frame = f.root.querySelector('.preview-frame');
  code.value = 'unsaved code\n'.repeat(50);
  code.dispatchEvent(new f.Event('input'));
  code.selectionStart = 8; code.selectionEnd = 16; code.scrollTop = 180; code.scrollLeft = 35;
  f.state.messages.push({ id: 'reply', role: 'assistant', content: 'A new reply' });
  f.render();
  f.state.settingsOpen = true; f.render();
  f.state.settingsOpen = false; f.state.editorClosed = true; f.render();
  f.state.editorClosed = false; f.state.previewHidden = true; f.render();
  f.state.previewHidden = false; f.state.vscodeUrl = 'http://localhost:8080/'; f.state.vscodeView = true; f.render();
  f.state.vscodeView = false; f.render();
  assert.equal(f.root.querySelector('#code'), code);
  assert.equal(code.selectionStart, 8); assert.equal(code.selectionEnd, 16);
  assert.equal(code.scrollTop, 180); assert.equal(code.scrollLeft, 35);
  assert.equal(code.value, 'unsaved code\n'.repeat(50));
  assert.equal(f.root.querySelector('.preview-frame'), frame);
  assert.ok(f.state.dirtyFiles.has(f.state.active));
});

test('render never rewrites iframe src except navigation or explicit reload', () => {
  const f = fixture(), frame = f.root.querySelector('.preview-frame');
  const original = frame.setAttribute.bind(frame), sources = [];
  frame.setAttribute = (name, value) => { if (name === 'src') sources.push(value); original(name, value); };
  for (let i = 0; i < 5; i++) f.render();
  assert.deepEqual(sources, []);
  f.state.previewUrl = 'http://localhost:3000/docs'; f.render();
  assert.deepEqual(sources, ['http://localhost:3000/docs']);
  f.app(true);
  assert.deepEqual(sources, ['http://localhost:3000/docs', 'http://localhost:3000/docs']);
});

test('persistent buttons have exactly one owned listener after repeated renders', () => {
  const f = fixture();
  for (let i = 0; i < 10; i++) f.render();
  f.root.querySelector('#toggle-preview').click();
  assert.equal(f.state.previewHidden, true);
  f.root.querySelector('#toggle-preview').click();
  assert.equal(f.state.previewHidden, false);
});

test('appending messages retains old message nodes and scroll while reading history', () => {
  const f = fixture();
  f.state.messages.push({ id: 'old', role: 'user', content: 'Earlier message' }); f.render();
  const old = f.root.querySelector('[data-message-id="old"]'), chat = f.root.querySelector('#chat');
  chat.scrollTop = 70;
  Object.defineProperties(chat, { scrollHeight: { value: 2000 }, clientHeight: { value: 400 } });
  f.state.sending = true;
  f.state.messages.push({ id: 'new', role: 'assistant', content: 'New response' }); f.render();
  assert.equal(f.root.querySelector('[data-message-id="old"]'), old);
  assert.equal(chat.scrollTop, 70);
  chat.scrollTop = 1600;
  f.state.messages.push({ id: 'follow', role: 'assistant', content: 'Follow-up' }); f.render();
  assert.equal(chat.scrollTop, 2000);
});

test('tool activity is compact by default and raw output is available on demand', () => {
  const f = fixture();
  f.state.messages.push(
    { id: 'call-message', role: 'assistant', content: '', tool_calls: [{ id: 'call-read', name: 'read', arguments: { filePath: 'src/app/page.tsx' } }] },
    { id: 'tool-result', role: 'tool', name: 'read', tool_call_id: 'call-read', content: 'export default function Page() {}' }
  );
  f.render();
  assert.equal(f.root.querySelector('[data-message-id="call-message"]'), null);
  const activity = f.root.querySelector('details[data-message-id="tool-result"]');
  assert.ok(activity);
  assert.equal(activity.open, false);
  assert.match(activity.querySelector('summary').textContent, /Read.*src\/app\/page\.tsx.*Done/);
  assert.match(activity.querySelector('.tool-output').textContent, /export default/);
});

test('active tools report what the agent is doing until their result arrives', () => {
  const f = fixture();
  f.state.messages.push({ id: 'active-call', role: 'assistant', content: '', tool_calls: [{ id: 'call-edit', name: 'edit', arguments: { filePath: 'src/app/globals.css' } }] });
  f.render();
  assert.match(f.root.querySelector('.tool-running-row').textContent, /Editing.*src\/app\/globals\.css.*Working/);
  f.state.messages.push({ id: 'edit-result', role: 'tool', name: 'edit', tool_call_id: 'call-edit', content: 'Wrote src/app/globals.css' });
  f.render();
  assert.equal(f.root.querySelector('.tool-running-row'), null);
  assert.match(f.root.querySelector('[data-message-id="edit-result"]').textContent, /Edited.*Done/);
});

test('completed agent work shows only the verified edited files and opens them in the editor', () => {
  const f = fixture();
  f.state.messages.push({
    id: 'completion', role: 'assistant', mode: 'agent', completion: true,
    content: 'Updated both button styles and verified the result.', durationMs: 754_000, editedFiles: ['src/app/globals.css']
  });
  f.render();
  const result = f.root.querySelector('[data-message-id="completion"]');
  assert.ok(result.classList.contains('completion'));
  assert.equal(result.querySelector('.completion-worked').textContent.trim(), 'Worked for 12m 34s›');
  assert.equal(result.querySelector('.completion-summary').textContent, 'Updated both button styles and verified the result.');
  assert.equal(result.querySelector('.completion-edits-head').textContent.includes('Edited 1 file'), true);
  assert.equal(result.querySelectorAll('[data-open-edited-file]').length, 1);
  assert.equal(result.textContent.includes('Verification Summary'), false);
  result.querySelector('[data-open-edited-file]').click();
  assert.equal(f.state.active, 'src/app/globals.css');
  assert.equal(f.state.editorClosed, false);
});

test('late WebView animation frame cannot override a newer user scroll', () => {
  const f = fixture(), chat = f.root.querySelector('#chat');
  Object.defineProperties(chat, { scrollHeight: { value: 2000 }, clientHeight: { value: 400 } });
  chat.scrollTop = 1600;
  f.state.messages.push({ id: 'late', role: 'assistant', content: 'Delayed render' });
  f.app();
  chat.scrollTop = 100;
  while (f.frames.length) f.frames.shift()();
  assert.equal(chat.scrollTop, 100);
});

test('unsubmitted preview URL and selected provider model survive unrelated renders', () => {
  const f = fixture(), url = f.root.querySelector('#preview-url');
  url.value = 'http://localhost:4321/draft';
  f.state.settingsOpen = true; f.state.draftProvider = 'openai';
  f.render();
  const model = f.root.querySelector('select#model');
  assert.ok(model);
  model.selectedIndex = model.options.length - 1;
  const chosen = model.value;
  f.state.messages.push({ id: 'unrelated', role: 'assistant', content: 'Another reply' });
  f.render();
  assert.equal(url.value, 'http://localhost:4321/draft');
  assert.equal(f.root.querySelector('#model'), model);
  assert.equal(model.value, chosen);
});

test('provider model UI never presents paid OpenAI or Anthropic models as free', () => {
  const f = fixture();
  for (const provider of ['openai', 'anthropic']) {
    f.state.settingsOpen = true; f.state.modelPickerOpen = false; f.state.draftProvider = provider; f.render();
    assert.match(f.root.textContent, /Paid API models/);
    assert.doesNotMatch(f.root.querySelector('#model').textContent, /Free tier/);
    assert.match(f.root.querySelector('#model').textContent, /Paid API/);
  }
  f.state.draftProvider = 'gemini'; f.render();
  assert.equal(f.root.querySelector('#model').value, 'gemini-3.6-flash');
  assert.match(f.root.textContent, /Limited free tier/);
  assert.match(f.root.querySelector('#model').textContent, /Gemini 3\.6 Flash · Free tier/);
  assert.doesNotMatch(f.root.querySelector('#model').textContent, /Gemini 2\.5 Flash/);
});
