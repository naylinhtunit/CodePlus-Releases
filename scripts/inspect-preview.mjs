// Read-only layout inspection in an isolated browser profile. No user cookies,
// arbitrary evaluation, shell interpolation, or browser-security overrides.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';

export function validatePreviewRequest(input) {
  const url = new URL(String(input.url || ''));
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      || url.username || url.password || Number(url.port || 80) < 1024) {
    throw new Error('Inspect only an HTTP localhost development server on port 1024 or higher.');
  }
  return { url: url.href, width: Math.max(240, Math.min(1920, Math.round(Number(input.width) || 400))) };
}

function browserPath() {
  const candidates = process.platform === 'darwin' ? [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    path.join(homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
  ] : process.platform === 'win32' ? [
    ...['ProgramFiles', 'ProgramFiles(x86)', 'LOCALAPPDATA'].flatMap(key => process.env[key] ? [
      path.join(process.env[key], 'Google/Chrome/Application/chrome.exe'),
      path.join(process.env[key], 'Microsoft/Edge/Application/msedge.exe')
    ] : [])
  ] : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  const found = candidates.find(existsSync);
  if (!found) throw new Error('Preview inspection needs Google Chrome or Microsoft Edge installed.');
  return found;
}

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
// This expression is fixed, not supplied by the model. It reports layout only.
const measure = `(() => {
  const describe = el => {
    if (!el) return null;
    const r = el.getBoundingClientRect(), s = getComputedStyle(el);
    return { tag: el.tagName, className: String(el.className).slice(0,200),
      width: r.width, height: r.height, display: s.display, widthRule: s.width,
      maxWidth: s.maxWidth, minWidth: s.minWidth, flex: s.flex,
      flexDirection: s.flexDirection, alignItems: s.alignItems };
  };
  return { url: location.href, viewport: innerWidth, title: document.title,
    elements: [...document.querySelectorAll('button,a,[role="button"]')]
      .filter(el => !(el.tagName === 'A' && el.querySelector('button')))
      .filter(el => el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0)
      .slice(0,60).map(el => ({ label: (el.getAttribute('aria-label') || el.innerText || '').trim().slice(0,160),
        ...describe(el), parent: describe(el.parentElement) })) };
})()`;

export async function inspectPreview(input) {
  const request = validatePreviewRequest(input);
  if (typeof WebSocket !== 'function') throw new Error('Preview inspection requires Node.js 22 or newer.');
  const executable = browserPath();
  const profile = await mkdtemp(path.join(tmpdir(), 'codeplus-preview-'));
  let browser, socket;
  const pending = new Map();
  const deadline = Date.now() + 25000;
  const checkTime = () => { if (Date.now() > deadline) throw new Error('Preview inspection timed out. Start the dev server and retry.'); };
  try {
    browser = spawn(executable, ['--headless=new', '--no-first-run', '--no-default-browser-check',
      '--disable-extensions', '--disable-background-networking', '--remote-debugging-port=0',
      `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore', windowsHide: true });
    let spawnError;
    browser.on('error', error => { spawnError = error; });
    let port;
    while (!port) {
      checkTime();
      if (spawnError) throw spawnError;
      if (browser.exitCode !== null) throw new Error('The inspection browser exited before startup.');
      try { port = Number((await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); } catch {}
      if (!port) await pause(100);
    }
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(3000) })).json();
    const target = targets.find(item => item.type === 'page');
    if (!target) throw new Error('Could not create preview inspection page.');
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Inspection browser connection timed out.')), 3000);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Inspection browser connection failed.')); }, { once: true });
    });
    let sequence = 0;
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out.`)); }, Math.max(1, Math.min(6000, deadline - Date.now())));
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params }));
    });
    socket.addEventListener('message', event => {
      const message = JSON.parse(String(event.data));
      const call = pending.get(message.id);
      if (call) {
        clearTimeout(call.timer); pending.delete(message.id);
        if (message.error) call.reject(new Error(message.error.message)); else call.resolve(message.result);
      }
      // Never follow top-level redirects to a different origin.
      if (message.method === 'Fetch.requestPaused') {
        const p = message.params;
        let allowed = false;
        try { allowed = new URL(p.request.url).origin === new URL(request.url).origin; } catch {}
        send(allowed ? 'Fetch.continueRequest' : 'Fetch.failRequest', allowed ? { requestId: p.requestId } : { requestId: p.requestId, errorReason: 'BlockedByClient' }).catch(() => {});
      }
    });
    await send('Page.enable');
    await send('Network.enable');
    await send('Network.setCacheDisabled', { cacheDisabled: true });
    await send('Fetch.enable', { patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' }] });
    const snapshots = [];
    for (const width of [...new Set([request.width, 375, 1280])]) {
      checkTime();
      await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      if (!snapshots.length) {
        const nav = await send('Page.navigate', { url: request.url });
        if (nav.errorText) throw new Error(`Preview navigation failed: ${nav.errorText}`);
      }
      let snapshot, previous, stable = 0;
      while (stable < 2) {
        checkTime();
        await pause(200);
        const ready = await send('Runtime.evaluate', { expression: 'document.readyState === "complete" && document.fonts.status === "loaded"', returnByValue: true });
        if (!ready.result?.value) continue;
        const result = await send('Runtime.evaluate', { expression: measure, returnByValue: true });
        snapshot = result.result?.value;
        if (!snapshot || new URL(snapshot.url).origin !== new URL(request.url).origin) throw new Error('Preview redirected or could not be measured.');
        const serialized = JSON.stringify(snapshot);
        stable = serialized === previous ? stable + 1 : 0;
        previous = serialized;
      }
      snapshots.push(snapshot);
    }
    return { status: 'measured', engine: 'isolated Chromium (not the embedded WebView)', snapshots };
  } finally {
    for (const call of pending.values()) { clearTimeout(call.timer); call.reject(new Error('Inspection closed.')); }
    socket?.close();
    if (browser && browser.exitCode === null) {
      browser.kill();
      await Promise.race([new Promise(resolve => browser.once('exit', resolve)), pause(1500)]);
      if (browser.exitCode === null) browser.kill('SIGKILL');
    }
    await rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }).catch(() => {});
  }
}

if (process.env.CODEPLUS_PREVIEW_REQUEST) {
  try { console.log(JSON.stringify(await inspectPreview(JSON.parse(process.env.CODEPLUS_PREVIEW_REQUEST)))); }
  catch (error) { console.log(JSON.stringify({ status: 'unavailable', error: error.message })); process.exitCode = 1; }
}
