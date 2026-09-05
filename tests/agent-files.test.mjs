import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import * as auditTools from '../public/agent-turn.js';
import * as intentTools from '../public/prompt-intent.js';
import * as historyTools from '../public/agent-history.js';

const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
function fixture(desktop) {
  const disk = new Map([['page.tsx', 'first']]);
  const sandbox = { ...auditTools, ...intentTools, ...historyTools, console, URL, Map, Set, structuredClone, AbortController,
    window: desktop ? { __TAURI_INTERNALS__: {} } : {},
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    document: { querySelector: () => null }, location: { pathname: '/app' },
    setTimeout, clearTimeout, requestAnimationFrame: fn => fn() };
  vm.createContext(sandbox);
  vm.runInContext(source.slice(0, source.lastIndexOf('\napp();')).replace(/^import .*;\r?\n/gm, '') + `
    app = () => {};
    scanWorkspace = async () => { state.treePaths = [...disk.keys()]; };
    readWorkspaceText = async (_, p) => { if (!disk.has(p)) throw new Error('File not found'); return disk.get(p); };
    writeWorkspaceText = async (_, p, c) => disk.set(p, c);
    state.dirPath = '/fixture'; state.treePaths = ['page.tsx']; state.files = { 'page.tsx': 'stale cache' };
    this.fixture = { state, executeTool, agentRead, agentEdit, agentWrite, agentCompletionMessage, sendPrompt };
  `, sandbox);
  sandbox.disk = disk;
  return { ...sandbox.fixture, disk, sandbox };
}

test('agent completion keeps a compact summary, duration and audited edited files', () => {
  const f = fixture(false), audit = auditTools.createToolAudit();
  audit.changed.add('z.css');
  audit.changed.add('src/a.ts');
  const message = f.agentCompletionMessage(audit, '**Updated the page**\n\n- Matched both controls.\n- Verified responsive behavior.\nExtra line.\nIgnored line.', 83_000);
  assert.match(message.content, /^Updated the page\n• Matched both controls\./);
  assert.doesNotMatch(message.content, /Ignored line/);
  assert.equal(message.durationMs, 83_000);
  assert.deepEqual([...message.editedFiles], ['src/a.ts', 'z.css']);
  assert.equal(message.completion, true);
});

for (const desktop of [false, true]) {
  test(`${desktop ? 'desktop' : 'web'}: a false model success is withheld after measured mismatch and bounded repairs`, async () => {
    const f = fixture(desktop);
    f.sandbox.document.querySelector = selector => selector === '#prompt' ? { value: 'Set View docs to the same width as Start building' } : null;
    f.sandbox.report = { status: 'measured', snapshots: [{ viewport: 400, elements: [{ label: 'View docs', width: 168 }, { label: 'Start building', width: 304 }] }] };
    vm.runInContext(`
      persistChatHistory = () => {};
      state.provider = 'local'; state.model = 'test'; state.messages = [];
      agentInspectPreview = async audit => { audit.preview = report; audit.previewRevision = audit.changeRevision; return JSON.stringify(report); };
      let responses = 0;
      callModel = async () => {
        responses++;
        if (responses === 1) return { content: '', tool_calls: [{name:'read',arguments:{filePath:'page.tsx'}}] };
        if (responses === 2) return { content: '', tool_calls: [{name:'edit',arguments:{filePath:'page.tsx',oldString:'first',newString:'changed'}}] };
        if (responses === 3) return { content: '', tool_calls: [{name:'read',arguments:{filePath:'page.tsx'}}] };
        return { content: 'Both buttons are verified equal. Everything is done.' };
      };
    `, f.sandbox);
    await f.sendPrompt({ preventDefault() {} });
    const final = f.state.messages.at(-1);
    assert.equal(final.error, true);
    assert.match(final.content, /measured controls still differ/);
    assert.equal(f.state.messages.some(m => m.content === 'Both buttons are verified equal. Everything is done.'), false);
    assert.equal(f.disk.get('page.tsx'), 'changed');
    assert.equal(f.state.sending, false);
  });
}

for (const desktop of [false, true]) {
  const platform = desktop ? 'desktop' : 'web';
  test(`${platform}: reads use fresh disk content, not editor cache`, async () => {
    const f = fixture(desktop), audit = auditTools.createToolAudit();
    assert.equal(await f.executeTool('read', { filePath: 'page.tsx' }, audit), 'first');
    f.disk.set('page.tsx', 'external change');
    assert.equal(await f.executeTool('read', { filePath: 'page.tsx' }, audit), 'external change');
    assert.equal(audit.snapshots.get('page.tsx'), 'external change');
  });
  test(`${platform}: external writes and unsaved drafts are never silently overwritten`, async () => {
    const f = fixture(desktop), audit = auditTools.createToolAudit();
    await f.executeTool('read', { filePath: 'page.tsx' }, audit);
    f.disk.set('page.tsx', 'first external');
    await assert.rejects(f.executeTool('edit', { filePath: 'page.tsx', oldString: 'first', newString: 'agent' }, audit), /changed since read/);
    assert.equal(f.disk.get('page.tsx'), 'first external');
    f.state.dirtyFiles.add('page.tsx');
    await assert.rejects(f.executeTool('read', { filePath: 'page.tsx' }, audit), /Unsaved editor/);
    await assert.rejects(f.agentWrite('page.tsx', 'agent', audit), /Unsaved editor/);
  });
  test(`${platform}: ambiguous edits fail, no-op writes do not count as work`, async () => {
    const f = fixture(desktop), audit = auditTools.createToolAudit();
    f.disk.set('page.tsx', 'same same');
    await f.executeTool('read', { filePath: 'page.tsx' }, audit);
    await assert.rejects(f.agentEdit('page.tsx', 'same', 'new', false, audit), /Ambiguous/);
    await assert.rejects(f.agentEdit('page.tsx', '', 'new', false, audit), /empty/);
    assert.match(await f.executeTool('write', { filePath: 'page.tsx', content: 'same same' }, audit), /No change/);
    assert.equal(audit.changed.size, 0);
    assert.equal(audit.changeRevision, 0);
    await f.executeTool('edit', { filePath: 'page.tsx', oldString: 'same', newString: 'new', replaceAll: true }, audit);
    assert.equal(f.disk.get('page.tsx'), 'new new');
    assert.equal(audit.changeRevision, 1);
  });
  test(`${platform}: external new files are discovered before a write`, async () => {
    const f = fixture(desktop), audit = auditTools.createToolAudit();
    audit.explored = true;
    f.disk.set('new.ts', 'external');
    assert.match(await f.executeTool('write', { filePath: 'new.ts', content: 'agent' }, audit), /before overwriting/);
    assert.equal(f.disk.get('new.ts'), 'external');
  });
}
