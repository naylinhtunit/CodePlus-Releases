import { state, app } from '/app.js';

Object.assign(state, { customPreview: true, previewUrl: `${location.origin}/frame`, localModelsLoaded: true, files: { 'a.ts': 'const a = 1;\n'.repeat(150), 'b.css': 'body { color: red; }', 'page.tsx': '<main>Test</main>' }, active: 'a.ts', model: 'test-model', messages: Array.from({ length: 35 }, (_, i) => ({ id: `test-${i}`, role: i % 2 ? 'assistant' : 'user', content: `Test message ${i}. `.repeat(20) })) });
Object.assign(state, { dirHandle: null, dirPath: '', treePaths: [], activeProjectId: 'memory:regression', projectName: 'Regression', projects: [{ id: 'memory:regression', kind: 'memory', name: 'Regression' }] });
state.expandedProjects['memory:regression'] = true;
app();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const check = (condition, message) => { if (!condition) throw new Error(message); };
async function run() {
  const results = [];
  try {
    // Explicitly emulate WebViews without the experimental moveBefore API.
    Element.prototype.moveBefore = undefined;
    const frame = document.querySelector('.preview-frame');
    if (frame.contentWindow.location.href !== state.previewUrl || frame.contentDocument?.readyState !== 'complete') await new Promise(resolve => frame.addEventListener('load', resolve, { once: true }));
    const originalDocument = frame.contentDocument;
    let loads = 0, detached = false;
    frame.addEventListener('load', () => loads++);
    const ancestors = []; for (let n = frame; n && n !== document.body; n = n.parentNode) ancestors.push(n);
    const observer = new MutationObserver(records => { if (records.some(record => [...record.removedNodes].some(node => ancestors.includes(node)))) detached = true; });
    observer.observe(document.querySelector('#app'), { subtree: true, childList: true });
    const prompt = document.querySelector('#prompt');
    prompt.value = 'Keep my draft'; prompt.dispatchEvent(new Event('input'));
    const chat = document.querySelector('#chat');
    await pause(100); chat.scrollTop = 150;
    for (let i = 0; i < 15; i++) {
      const file = ['a.ts', 'b.css', 'page.tsx'][i % 3];
      document.querySelector(`[data-file="${file}"]`).click(); await pause(20);
      check(document.querySelector('#code').value === state.files[file], 'File contents must update correctly');
    }
    check(chat.scrollTop === 150 && document.querySelector('#chat') === chat, `Chat scroll/node changed on file switch: ${chat.scrollTop}, ${chat.clientHeight}/${chat.scrollHeight}, same=${document.querySelector('#chat') === chat}`);
    check(prompt.value === 'Keep my draft' && document.querySelector('#prompt') === prompt, 'Composer draft/node changed');
    results.push('15 file switches: preview and chat retained');

    document.querySelector('[data-file="a.ts"]').click();
    const code = document.querySelector('#code');
    code.value += '\n// unsaved'; code.dispatchEvent(new Event('input')); code.focus();
    code.setSelectionRange(10, 18); code.scrollTop = 200;
    state.messages.push({ id: 'new-reply', role: 'assistant', content: 'Test reply' }); app(); await pause(60);
    check(document.activeElement === code && code.selectionStart === 10 && code.selectionEnd === 18 && code.scrollTop === 200, 'Reply disturbed editor selection/focus/scroll');
    check(chat.scrollTop === 150, 'Reply interrupted reading old chat');
    results.push('Reply: editor focus, selection, unsaved text and history scroll retained');

    document.querySelector('#settings').click(); await pause(20); document.querySelector('#cancel-settings').click();
    document.querySelector('#toggle-preview').click(); await pause(20); document.querySelector('#toggle-preview').click();
    document.querySelector('#close-file').click(); await pause(20); document.querySelector('[data-file="a.ts"]').click();
    state.vscodeUrl = `${location.origin}/frame?vscode`; state.vscodeView = true; app(); await pause(40);
    document.querySelector('#close-vscode').click(); await pause(100);
    check(!detached && loads === 0 && frame.contentDocument === originalDocument, `Preview reloaded/detached: ${loads}/${detached}`);
    check(frame.getBoundingClientRect().width > 100 && frame.getBoundingClientRect().height > 100, 'Preview layout is broken');
    results.push('Settings, hide/show, close/reopen and VS Code view: zero preview reloads');
    observer.disconnect();

    app(true); await pause(250);
    check(loads === 1 && frame.contentDocument !== originalDocument, 'Explicit reload must still work');
    results.push('Explicit preview reload: exactly one load');
    state.previewUrl = `${location.origin}/frame?navigation`; app(true); await pause(250);
    check(loads === 2, 'URL navigation must load exactly once');
    results.push('URL navigation: exactly one load');

    const originalFetch = window.fetch;
    const chatPayloads = [];
    window.fetch = async (url, options = {}) => {
      if (url === '/api/chat') {
        chatPayloads.push(JSON.parse(options.body));
        return new Response(JSON.stringify({ answer: 'မင်္ဂလာပါ' }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return originalFetch(url, options);
    };
    const send = async text => {
      const input = document.querySelector('#prompt');
      input.value = text;
      document.querySelector('#composer').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      for (let i = 0; i < 100 && (state.sending || chatPayloads.length === 0); i++) await pause(10);
      await pause(20);
    };
    await send('ဟလို');
    const casual = chatPayloads.at(-1);
    check(casual.toolsEnabled === false, 'Casual greeting enabled tools');
    check(casual.requireTool === false, 'Casual greeting required a tool');
    check(!casual.context && !JSON.stringify(casual.messages).includes('Workspace:'), 'Casual greeting leaked workspace context');
    check(!casual.messages.some(message => message.role === 'tool' || message.tool_calls), 'Casual greeting included stale tool history');
    await send('Please fix the button in src/app/page.tsx');
    const coding = chatPayloads.at(-1);
    check(coding.toolsEnabled === true, 'Explicit coding request did not enable tools');
    check(coding.requireTool === true, 'Explicit coding request did not require an initial tool');
    window.fetch = originalFetch;
    results.push('Prompt routing: greetings use one tool-free request; coding requests enable tools');

    state.messages.push({ id: 'progress-call', role: 'assistant', content: '', tool_calls: [{ id: 'progress-edit', name: 'edit', arguments: { filePath: 'b.css' } }] });
    app(); await pause(20);
    check(/Editing.*b\.css.*Working/.test(document.querySelector('.tool-running-row')?.textContent || ''), 'Live tool progress is not visible');
    state.messages.push({ id: 'progress-result', role: 'tool', name: 'edit', tool_call_id: 'progress-edit', content: 'Wrote b.css' });
    state.messages.push({ id: 'progress-complete', role: 'assistant', mode: 'agent', completion: true, content: 'Changes completed.', editedFiles: ['b.css'] });
    app(); await pause(20);
    check(!document.querySelector('.tool-running-row'), 'Finished tool still appears as running');
    const editedFile = document.querySelector('[data-open-edited-file="b.css"]');
    check(editedFile && /Changes completed\./.test(document.querySelector('[data-message-id="progress-complete"]')?.textContent || ''), 'Concise completion or edited file is missing');
    editedFile.click(); await pause(20);
    check(state.active === 'b.css' && document.querySelector('#code').value === state.files['b.css'], 'Edited file result did not open in editor');
    results.push('Agent progress: live Working state, compact completion and edited-file open verified');
    document.querySelector('#test-results').textContent = 'PASS\n' + results.join('\n');
    window.webkit?.messageHandlers?.results?.postMessage({ ok: true, results });
  } catch (error) {
    document.querySelector('#test-results').textContent = `FAIL: ${error.message}\n${error.stack || ''}\n${results.join('\n')}`;
    window.webkit?.messageHandlers?.results?.postMessage({ ok: false, error: error.message, results });
  }
}
document.querySelector('#run-regression').addEventListener('click', run);
if (new URLSearchParams(location.search).has('autorun')) run();
