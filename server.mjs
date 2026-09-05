import http from 'node:http';
import { mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { spawn, exec, execSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { inspectPreview } from './scripts/inspect-preview.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 4173);
const require = createRequire(import.meta.url);

// Tiny .env loader: keeps the project dependency-free for an easy local start.
if (existsSync(path.join(root, '.env'))) {
  const env = require('node:fs').readFileSync(path.join(root, '.env'), 'utf8');
  for (const line of env.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)=(.*)\s*$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^['\"]|['\"]$/g, '');
  }
}

const json = (res, status, value) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
};

let vscodeWebProcess;
const devServers = new Map();

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

const stripAnsi = text => String(text).replace(/\x1b\[[0-9;]*m/g, '');
async function probePort(port, timeoutMs = 1200) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/`, { method: 'HEAD', signal: AbortSignal.timeout(timeoutMs) });
    return r.status >= 200 && r.status < 500;
  } catch { return false; }
}

function detectDevPort(absRoot) {
  let port = 3000;
  try {
    const raw = require('node:fs').readFileSync(path.join(absRoot, 'package.json'), 'utf8');
    const pkg = JSON.parse(raw);
    const script = pkg?.scripts?.dev || '';
    const m = script.match(/(?:^|\s)-p\s+(\d{2,5})/) || script.match(/--port[=\s]+(\d{2,5})/);
    if (m) return Number(m[1]);
    if (raw.includes('vite')) port = 5173;
  } catch {}
  if (existsSync(path.join(absRoot, 'vite.config.js')) || existsSync(path.join(absRoot, 'vite.config.ts'))) port = 5173;
  return port;
}

function killPort(port) {
  try {
    if (process.platform === 'win32') {
      execSync(`for /f "tokens=5" %a in ('netstat -aon ^| findstr :${port}') do taskkill /PID %a /F 2>nul`, { stdio: 'ignore', timeout: 3000, shell: 'cmd.exe' });
    } else {
      execSync(`lsof -ti:${port} 2>/dev/null | xargs kill -9 2>/dev/null || true`, { stdio: 'ignore', timeout: 3000, shell: '/bin/sh' });
    }
  } catch {}
}

async function startDevServer(root) {
  const absRoot = path.resolve(root || process.cwd());
  try { const s = await stat(absRoot); if (!s.isDirectory()) throw new Error('Not a directory'); } catch { throw new Error('Project folder not found: ' + absRoot); }
  const pkgPath = path.join(absRoot, 'package.json');
  if (!existsSync(pkgPath)) throw new Error('No package.json in ' + absRoot);
  try { const pkg = JSON.parse(require('node:fs').readFileSync(pkgPath, 'utf8')); if (!pkg.scripts || !pkg.scripts.dev) throw new Error('No "dev" script in package.json'); } catch (e) { if (e.message.includes('No "dev"')) throw e; throw new Error('Cannot read package.json: ' + e.message); }
  const existing = devServers.get(absRoot);
  if (existing && existing.pid && !existing.killed) {
    // already tracked — wait until it actually answers on its port
    for (let i = 0; i < 60; i++) { if (await probePort(new URL(existing.url).port)) return { url: existing.url, pid: existing.pid }; await wait(500); }
    return { url: existing.url, pid: existing.pid };
  }
  // port comes from the dev script (-p / --port), vite -> 5173, else 3000
  const port = detectDevPort(absRoot);
  // auto-install deps if node_modules missing (project was opened without it, e.g. via import)
  if (!existsSync(path.join(absRoot, 'node_modules'))) {
    await new Promise((resolve, reject) => {
      const installer = process.platform === 'win32'
        ? spawn('cmd', ['/d', '/c', 'npm', 'install'], { cwd: absRoot, stdio: 'ignore' })
        : spawn('sh', ['-l', '-c', 'npm install'], { cwd: absRoot, stdio: 'ignore' });
      let done = false;
      const timeout = setTimeout(() => { if (!done) { try { installer.kill(); } catch {} reject(new Error('npm install timed out after 120s')); } }, 120000);
      installer.once('close', code => { done = true; clearTimeout(timeout); code === 0 ? resolve() : reject(new Error('npm install failed (code ' + code + ') — check that Node.js and npm are installed')); });
      installer.once('error', err => { done = true; clearTimeout(timeout); reject(new Error('Failed to run npm install: ' + err.message + ' — is npm installed?')); });
    });
  }
  const url = `http://localhost:${port}/`;
  // if something already serves the project port, adopt it instead of spawning a duplicate
  if (await probePort(port)) return { url, adopted: true };
  // clear stale listeners on the exact port so the dev server can bind (e.g. zombie from a previous session)
  killPort(port);
  await wait(400);
  const outputTail = [];
  const capture = chunk => { outputTail.push(stripAnsi(String(chunk))); if (outputTail.length > 60) outputTail.shift(); };
  const child = process.platform === 'win32'
    ? spawn('cmd', ['/d', '/c', 'npm', 'run', 'dev'], { cwd: absRoot, stdio: ['ignore', 'pipe', 'pipe'], detached: true, env: { ...process.env, PORT: String(port) } })
    : spawn('sh', ['-l', '-c', 'exec npm run dev'], { cwd: absRoot, stdio: ['ignore', 'pipe', 'pipe'], detached: true, env: { ...process.env, PORT: String(port) } });
  child.url = url;
  child.stdout?.on('data', capture);
  child.stderr?.on('data', capture);
  devServers.set(absRoot, child);
  let exited = false;
  child.once('exit', () => { exited = true; devServers.delete(absRoot); });
  child.once('error', () => { exited = true; devServers.delete(absRoot); });
  if (child.pid) { try { child.unref(); } catch {} }
  // wait until the dev server actually accepts connections (up to 90s)
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    if (exited) throw new Error(`Dev server exited immediately — last output:\n${outputTail.join('').slice(-1500).trim() || '(no output)'}`);
    if (await probePort(port)) return { url, pid: child.pid };
    await wait(600);
  }
  try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch {}
  devServers.delete(absRoot);
  throw new Error(`Dev server did not become ready within 90s — last output:\n${outputTail.join('').slice(-1500).trim() || '(no output)'}`);
}

function stopDevServer(root) {
  const targets = root ? [path.resolve(root)] : [...devServers.keys()];
  let stopped = false;
  for (const absRoot of targets) {
    const child = devServers.get(absRoot);
    if (child) {
      try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGTERM'); else child.kill(); } catch {}
      try { child.kill('SIGKILL'); } catch {}
      devServers.delete(absRoot);
      stopped = true;
    }
  }
  // also kill the project's own dev port (e.g. `next dev -p 9002`) — covers adopted servers
  if (root) {
    for (const absRoot of targets) {
      try { killPort(detectDevPort(absRoot)); stopped = true; } catch {}
    }
  }
  // also kill anything still listening on dev ports (covers manually started terminals)
  try {
    if (process.platform === 'win32') {
      execSync('for /f "tokens=5" %a in (\'netstat -aon ^| findstr :3000\') do taskkill /PID %a /F 2>nul', { stdio: 'ignore', timeout: 3000, shell: 'cmd.exe' });
      execSync('for /f "tokens=5" %a in (\'netstat -aon ^| findstr :5173\') do taskkill /PID %a /F 2>nul', { stdio: 'ignore', timeout: 3000, shell: 'cmd.exe' });
    } else {
      execSync('lsof -ti:3000,5173 2>/dev/null | xargs kill -9 2>/dev/null || true', { stdio: 'ignore', timeout: 3000, shell: '/bin/sh' });
    }
  } catch {}
  return stopped;
}

async function startVSCodeWeb() {
  if (vscodeWebProcess && !vscodeWebProcess.killed) return { url: 'http://127.0.0.1:8765/' };
  const args = [
    'serve-web', '--host', '127.0.0.1', '--port', '8765', '--without-connection-token',
    '--accept-server-license-terms', '--disable-telemetry', '--default-folder', root,
    '--server-data-dir', path.join(root, '.codeplus', 'vscode-server')
  ];
  const codeCli = '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code';
  let child;
  if (process.platform === 'win32') {
    // The Windows CLI is code.cmd, which Node cannot spawn directly.
    child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'code', ...args], { stdio: 'ignore', windowsHide: true });
  } else {
    const command = process.platform === 'darwin' && existsSync(codeCli) ? codeCli : 'code';
    child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.unref();
  }
  child.once('error', () => { vscodeWebProcess = undefined; });
  child.once('exit', () => { vscodeWebProcess = undefined; });
  vscodeWebProcess = child;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await fetch('http://127.0.0.1:8765/');
      if (response.ok || response.status === 302) return { url: 'http://127.0.0.1:8765/' };
    } catch { /* VS Code is still starting. */ }
    await wait(250);
  }
  throw new Error('VS Code web workspace did not start. Try again in a moment.');
}

async function body(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

const WORKSPACE_IGNORE = new Set(['node_modules', '.git', '.codeplus', '.next', '.nuxt', 'dist', 'build', 'target', 'venv', '.venv', '__pycache__', '.DS_Store']);
const WORKSPACE_BINARY_EXT = new Set(['png','jpg','jpeg','gif','webp','avif','ico','icns','pdf','zip','gz','tgz','bz2','xz','7z','rar','dmg','iso','exe','msi','dll','so','dylib','bin','o','a','class','jar','war','woff','woff2','ttf','otf','eot','mp3','wav','ogg','mp4','webm','mov','avi','mkv','sqlite','db','pdb','wasm']);
function isWorkspaceTextFile(name) {
  const ext = path.extname(name).slice(1).toLowerCase();
  return !ext || !WORKSPACE_BINARY_EXT.has(ext);
}
function resolveWorkspacePath(rootDir, relative = '', allowRoot = false) {
  if (typeof rootDir !== 'string' || !rootDir.trim()) throw new Error('Workspace root is required.');
  if (typeof relative !== 'string') throw new Error('Invalid workspace path.');
  const clean = relative.replace(/\\/g, '/').replace(/^\.\//, '');
  if ((!allowRoot && !clean) || path.isAbsolute(clean) || /^[A-Za-z]:\//.test(clean) || (clean && clean.split('/').some(segment => segment === '..' || segment === ''))) {
    throw new Error('Invalid workspace path. Use a relative path inside the open project.');
  }
  const absRoot = path.resolve(rootDir);
  const target = clean ? path.resolve(absRoot, clean) : absRoot;
  if (target !== absRoot && !target.startsWith(absRoot + path.sep)) throw new Error('Workspace path escaped the open project.');
  return { absRoot, target, relative: clean };
}
async function assertWorkspaceContainment(absRoot, target) {
  const canonicalRoot = await realpath(absRoot);
  let probe = target;
  while (!existsSync(probe) && probe !== absRoot) probe = path.dirname(probe);
  const canonicalProbe = await realpath(probe);
  if (canonicalProbe !== canonicalRoot && !canonicalProbe.startsWith(canonicalRoot + path.sep)) {
    throw new Error('Workspace path resolves outside the open project.');
  }
}
async function listWorkspaceTree(rootDir) {
  const { absRoot } = resolveWorkspacePath(rootDir, '', true);
  await assertWorkspaceContainment(absRoot, absRoot);
  const out = [];
  async function walk(dir, depth) {
    if (depth > 10 || out.length >= 8000) return;
    let entries = [];
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (WORKSPACE_IGNORE.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await walk(full, depth + 1);
      else if (entry.isFile() && isWorkspaceTextFile(entry.name)) out.push(path.relative(absRoot, full).split(path.sep).join('/'));
      if (out.length >= 8000) break;
    }
  }
  await walk(absRoot, 0);
  return out;
}
async function readWorkspaceFile(rootDir, relative) {
  const { absRoot, target } = resolveWorkspacePath(rootDir, relative);
  await assertWorkspaceContainment(absRoot, target);
  const info = await stat(target);
  if (!info.isFile()) throw new Error(`Not a file: ${relative}`);
  if (info.size > 5 * 1024 * 1024) throw new Error(`File is too large to edit: ${relative}`);
  return readFile(target, 'utf8');
}
async function writeWorkspaceFile(rootDir, relative, content) {
  if (typeof content !== 'string') throw new Error('File content must be text.');
  if (content.length > 5 * 1024 * 1024) throw new Error('File content exceeds the 5 MB workspace limit.');
  const { absRoot, target } = resolveWorkspacePath(rootDir, relative);
  await assertWorkspaceContainment(absRoot, target);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, 'utf8');
}
async function createWorkspaceDirectory(parent, name) {
  if (typeof name !== 'string' || !name.trim() || name !== path.basename(name) || name === '.' || name === '..') throw new Error('Invalid project name.');
  const { absRoot, target } = resolveWorkspacePath(parent, name.trim());
  await assertWorkspaceContainment(absRoot, target);
  await mkdir(target, { recursive: false }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  return target;
}

function textFromOpenAI(data) {
  if (data.output_text) return data.output_text;
  return data.output?.flatMap(item => item.content || [])
    .filter(part => part.type === 'output_text')
    .map(part => part.text).join('\n') || 'The model returned no text.';
}

async function ollamaFetch(url, options) {
  try {
    return await fetch(url, options);
  } catch {
    throw new Error(`Could not connect to Ollama at ${new URL(url).origin}. Start the Ollama app or run "ollama serve" first.`);
  }
}

async function listLocalModels(endpoint) {
  const baseUrl = (endpoint || process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434').replace(/\/$/, '');
  const response = await ollamaFetch(`${baseUrl}/api/tags`);
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = {}; }
  if (!response.ok) throw new Error(data.error || text.trim() || 'Could not read the Ollama model list');
  return (data.models || []).map(item => ({ name: item.name, size: item.size, modifiedAt: item.modified_at }));
}

async function streamPullLocalModel(res, endpoint, model) {
  if (typeof model !== 'string' || !/^[a-zA-Z0-9._:/-]{1,160}$/.test(model)) throw new Error('Choose a valid Ollama model name');
  const baseUrl = (endpoint || process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434').replace(/\/$/, '');
  const response = await ollamaFetch(`${baseUrl}/api/pull`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, stream: true })
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || `Could not download ${model}`);
  }
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-cache' });
  const reader = response.body?.getReader();
  if (!reader) return res.end(JSON.stringify({ status: 'success' }) + '\n');
  while (true) {
    const { done, value } = await reader.read();
    if (value) res.write(value);
    if (done) break;
  }
  res.end();
}

async function deleteLocalModel(endpoint, model) {
  if (typeof model !== 'string' || !/^[a-zA-Z0-9._:/-]{1,160}$/.test(model)) throw new Error('Choose a valid Ollama model name');
  const baseUrl = (endpoint || process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434').replace(/\/$/, '');
  const response = await ollamaFetch(`${baseUrl}/api/delete`, {
    method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model, name: model })
  });
  if (response.ok) return { model, status: 'deleted' };
  const text = await response.text().catch(() => '');
  try {
    const data = JSON.parse(text);
    throw new Error(data.error || text.trim() || `Could not delete ${model}`);
  } catch (e) {
    if (e.message && !e.message.includes('is not valid JSON')) throw e;
    throw new Error(text.trim() || `Could not delete ${model}: ${response.status} ${response.statusText}`);
  }
}

const OPENAI_COMPATIBLE = {
  groq: ['https://api.groq.com/openai/v1', 'GROQ_API_KEY'],
  deepseek: ['https://api.deepseek.com/v1', 'DEEPSEEK_API_KEY'],
  mistral: ['https://api.mistral.ai/v1', 'MISTRAL_API_KEY'],
  xai: ['https://api.x.ai/v1', 'XAI_API_KEY'],
  openrouter: ['https://openrouter.ai/api/v1', 'OPENROUTER_API_KEY'],
  together: ['https://api.together.xyz/v1', 'TOGETHER_API_KEY'],
  fireworks: ['https://api.fireworks.ai/inference/v1', 'FIREWORKS_API_KEY'],
  cerebras: ['https://api.cerebras.ai/v1', 'CEREBRAS_API_KEY']
};

const PROVIDER_MODEL_ENDPOINTS = {
  openai: ['https://api.openai.com/v1/models', 'OPENAI_API_KEY'],
  anthropic: ['https://api.anthropic.com/v1/models?limit=1000', 'ANTHROPIC_API_KEY'],
  gemini: ['https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000', 'GEMINI_API_KEY'],
  ...Object.fromEntries(Object.entries(OPENAI_COMPATIBLE).map(([id, [base, env]]) => [id, [`${base}/models`, env]]))
};

function providerModelError(data, text, provider) {
  return data?.error?.message || data?.error?.metadata?.raw || (typeof data?.error === 'string' ? data.error : '') || data?.message || text.trim().slice(0, 500) || `Could not fetch ${provider} models`;
}

function normalizeProviderModels(provider, data) {
  const source = Array.isArray(data) ? data : Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : Array.isArray(data?.items) ? data.items : [];
  const excluded = /(?:^|[-_/])(embedding|embed|rerank|moderation|whisper|transcri|speech|tts|dall-e|image|sora)(?:$|[-_/])/i;
  const seen = new Set();
  return source.filter(model => {
    if (provider === 'gemini' && Array.isArray(model.supportedGenerationMethods) && !model.supportedGenerationMethods.includes('generateContent')) return false;
    if (provider === 'together' && model.type && !['chat', 'language', 'code'].includes(model.type)) return false;
    if (provider === 'mistral' && model.capabilities && model.capabilities.completion_chat === false) return false;
    return true;
  }).map(model => {
    let id = String(model.id || model.name || '').replace(provider === 'gemini' ? /^models\// : /$^/, '');
    const name = String(model.displayName || model.display_name || (provider === 'gemini' ? model.baseModelId : '') || model.name || id).replace(/^models\//, '');
    if (!id || excluded.test(id) || seen.has(id)) return null;
    seen.add(id);
    return { id, name: name || id, pricing: model.pricing || {}, context_length: model.context_length || model.contextLength || model.inputTokenLimit || null, created: model.created || null };
  }).filter(Boolean);
}

async function listProviderModels(provider, suppliedKey = '') {
  const config = PROVIDER_MODEL_ENDPOINTS[provider];
  if (!config) throw Object.assign(new Error(`Unknown cloud provider: ${provider}`), { status: 400 });
  const [baseUrl, env] = config;
  const key = String(suppliedKey || process.env[env] || '').trim();
  if (!key) throw Object.assign(new Error(`${provider} API key required. Paste it in settings.`), { status: 400 });
  const headers = { Accept: 'application/json' };
  let url = baseUrl;
  if (provider === 'gemini') url += `${url.includes('?') ? '&' : '?'}key=${encodeURIComponent(key)}`;
  else if (provider === 'anthropic') { headers['x-api-key'] = key; headers['anthropic-version'] = '2023-06-01'; }
  else headers.Authorization = `Bearer ${key}`;
  if (provider === 'openrouter') { headers['HTTP-Referer'] = 'http://localhost:4173'; headers['X-Title'] = 'CodePlus'; }
  const response = await fetch(url, { headers });
  const text = await response.text();
  let data = {};
  try { data = JSON.parse(text); } catch {}
  if (!response.ok) throw Object.assign(new Error(providerModelError(data, text, provider)), { status: response.status });
  return normalizeProviderModels(provider, data);
}

// opencode-inspired agent tools — shared with the client (public/app.js) and Tauri (src-tauri/src/main.rs)
const AGENT_TOOLS = [
  { type: 'function', function: { name: 'inspect_preview', description: 'Measure visible buttons/links and parent layout at preview, mobile and desktop widths in an isolated browser. Use before and after UI sizing edits. May be unavailable if no local browser/runtime is installed.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'read', description: 'Read file content. Use to understand codebase before editing. Handles text files up to 40k chars.', parameters: { type: 'object', properties: { filePath: { type: 'string', description: 'Relative path from project root, e.g. src/app/page.tsx' } }, required: ['filePath'] } } },
  { type: 'function', function: { name: 'write', description: 'Create new file or overwrite existing one. Use for new files; prefer edit for surgical changes.', parameters: { type: 'object', properties: { filePath: { type: 'string', description: 'Relative path from project root' }, content: { type: 'string', description: 'Full file content' } }, required: ['filePath', 'content'] } } },
  { type: 'function', function: { name: 'edit', description: 'Exact string replacement in an existing file. oldString must match exactly including whitespace.', parameters: { type: 'object', properties: { filePath: { type: 'string' }, oldString: { type: 'string', description: 'Exact text to replace' }, newString: { type: 'string', description: 'Replacement text' }, replaceAll: { type: 'boolean', description: 'Replace all occurrences (default false)' } }, required: ['filePath', 'oldString', 'newString'] } } },
  { type: 'function', function: { name: 'bash', description: 'Run a shell command in the project root. Use for git, npm, tests, etc. Timeout 30s.', parameters: { type: 'object', properties: { command: { type: 'string', description: 'Shell command, e.g. git status --short or npm run build' } }, required: ['command'] } } },
  { type: 'function', function: { name: 'glob', description: 'Find files by glob pattern. Returns matching paths sorted by name.', parameters: { type: 'object', properties: { pattern: { type: 'string', description: 'Glob pattern, e.g. src/**/*.tsx or **/*.json' } }, required: ['pattern'] } } },
  { type: 'function', function: { name: 'grep', description: 'Search file contents with regex. Fast ripgrep-style search.', parameters: { type: 'object', properties: { pattern: { type: 'string', description: 'Regex pattern, e.g. function\\s+\\w+' }, include: { type: 'string', description: 'Optional glob to filter files, e.g. *.ts' } }, required: ['pattern'] } } },
  { type: 'function', function: { name: 'todowrite', description: 'Track progress on multi-step tasks. Call whenever you start/finish a step.', parameters: { type: 'object', properties: { todos: { type: 'array', items: { type: 'object', properties: { content: { type: 'string' }, status: { type: 'string', enum: ['pending','in_progress','completed','cancelled'] }, priority: { type: 'string', enum: ['high','medium','low'] } }, required: ['content','status','priority'] } } }, required: ['todos'] } } }
];

function openAITools() { return AGENT_TOOLS; }
function anthropicTools() {
  return AGENT_TOOLS.map(t => ({ name: t.function.name, description: t.function.description, input_schema: t.function.parameters }));
}
function geminiTools() {
  return [{ functionDeclarations: AGENT_TOOLS.map(t => ({
    name: t.function.name,
    description: t.function.description,
    parameters: t.function.parameters
  })) }];
}
function geminiContents(messages) {
  const toolNames = new Map();
  for (const message of messages) {
    for (const call of message.tool_calls || []) toolNames.set(call.id, call.name);
  }
  const contents = messages.filter(message => message.role !== 'system').map(message => {
    if (message.role === 'tool') {
      const name = message.name || toolNames.get(message.tool_call_id) || 'tool';
      return { role: 'user', parts: [{ functionResponse: { name, response: { output: String(message.content || '') } } }] };
    }
    if (message.tool_calls?.length) {
      const parts = [];
      if (message.content) parts.push({ text: String(message.content) });
      parts.push(...message.tool_calls.map(call => ({ functionCall: { name: call.name, args: call.arguments || {} }, ...(call.thought_signature ? { thoughtSignature: call.thought_signature } : {}) })));
      return { role: 'model', parts };
    }
    return { role: message.role === 'assistant' ? 'model' : 'user', parts: [{ text: String(message.content || '') }] };
  });
  return contents.reduce((out, item) => {
    if (out.at(-1)?.role === item.role) out.at(-1).parts.push(...item.parts);
    else out.push(item);
    return out;
  }, []);
}
function anthropicMessages(messages) {
  const out = [];
  const append = (role, blocks) => {
    const previous = out.at(-1);
    if (previous?.role === role && Array.isArray(previous.content)) previous.content.push(...blocks);
    else out.push({ role, content: blocks });
  };
  for (const message of messages) {
    if (message.role === 'system') continue;
    if (message.role === 'tool') {
      append('user', [{ type: 'tool_result', tool_use_id: message.tool_call_id, content: String(message.content || '') }]);
    } else if (message.tool_calls?.length) {
      const blocks = [];
      if (message.content) blocks.push({ type: 'text', text: String(message.content) });
      blocks.push(...message.tool_calls.map(call => ({ type: 'tool_use', id: call.id, name: call.name, input: call.arguments || {} })));
      append('assistant', blocks);
    } else {
      append(message.role === 'assistant' ? 'assistant' : 'user', [{ type: 'text', text: String(message.content || '') }]);
    }
  }
  return out;
}
function fixServerModel(provider, model) {
  if (!model) return model;
  if (provider === 'openrouter' && (model === 'openrouter/free' || model === 'openrouter')) return 'qwen/qwen3-coder:free';
  if (provider === 'gemini' && (model === 'gemini-2.5-flash' || model === 'models/gemini-2.5-flash')) return 'gemini-3.6-flash';
  return model;
}

async function chatCompletion(provider, base, key, model, messages, toolsEnabled = true, requireTool = false) {
  if (model === 'openrouter/free' || model === 'openrouter') model = 'qwen/qwen3-coder:free';
  const body = { model, messages: toOpenAIMessages(messages), ...(toolsEnabled ? { tools: openAITools(), tool_choice: requireTool ? 'required' : 'auto' } : {}) };
  const headers = { 'Content-Type': 'application/json' };
  if (key) headers.Authorization = `Bearer ${key}`;
  const response = await fetch(`${base.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST', headers,
    body: JSON.stringify(body)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${provider} HTTP ${response.status}: ${data.error?.message || data.error || 'Model request failed'}`);
  const msg = data.choices?.[0]?.message;
  if (msg?.tool_calls?.length) return { content: msg.content || '', tool_calls: msg.tool_calls.map(tc => ({ id: tc.id, name: tc.function.name, arguments: normalizeToolArgs((() => { try { return JSON.parse(tc.function.arguments || '{}'); } catch { return {}; } })()) })) };
  const fb = parseToolCallsFallback(msg?.content || '');
  if (fb) return { content: '', tool_calls: fb };
  if (!msg?.content?.trim()) throw new Error(`The model returned no answer (finish reason: ${data.choices?.[0]?.finish_reason || 'empty response'}). Retry or select another model.`);
  return { content: msg.content, tool_calls: null };
}

function withContext(messages, context) {
  if (!Array.isArray(context) || !context.length) return messages;
  const text = context.filter(item => item && item.name && typeof item.content === 'string')
    .map(item => `\n<attachment name="${String(item.name).replace(/[<>&"]/g, '')}">\n${item.content}\n</attachment>`).join('');
  if (!text) return messages;
  // inject as system message but keep tool messages intact
  const sys = { role: 'system', content: 'The user attached these project files and command outputs as context:' + text };
  const idx = messages.findIndex(m => m.role === 'system');
  if (idx >= 0) return [messages[idx], sys, ...messages.filter((_, i) => i !== idx)];
  return [sys, ...messages];
}

function normalizeMessagesForOllama(messages) {
  // Ollama expects tool messages as {role:'tool', content} and assistant tool_calls as [{function:{name,arguments}}]
  return messages.map(m => {
    if (m.role === 'tool') return { role: 'tool', content: String(m.content || ''), tool_name: m.name || messages.flatMap(item => item.tool_calls || []).find(call => call.id === m.tool_call_id)?.name };
    if (m.tool_calls) return { role: m.role, content: m.content || '', tool_calls: m.tool_calls.map(tc => ({ function: { name: tc.name || tc.function?.name, arguments: tc.arguments || tc.function?.arguments || {} } })) };
    return { role: m.role, content: m.content };
  });
}
function toOpenAIMessages(messages) {
  return messages.map(m => m.role === 'tool'
    ? { role: 'tool', tool_call_id: m.tool_call_id, content: String(m.content ?? '') }
    : m.tool_calls?.length
      ? { role: 'assistant', content: m.content || '', tool_calls: m.tool_calls.map(tc => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.arguments || {}) } })) }
      : { role: m.role, content: String(m.content ?? '') });
}
function ollamaBody(model, messages, tools = true) {
  return { model, messages: normalizeMessagesForOllama(messages), stream: false,
    think: /(?:^|\/)gpt-oss(?:[:\-/]|$)/i.test(model) ? (tools ? 'medium' : 'low') : false,
    options: { num_ctx: 16384, num_predict: 8192 }, ...(tools ? { tools: AGENT_TOOLS } : {}) };
}
function parseOllamaReply(data) {
  const msg = data.message || {};
  const calls = (msg.tool_calls || []).filter(tc => tc.function?.name || tc.name).map(tc => {
    let args = tc.function?.arguments || tc.arguments || {};
    if (typeof args === 'string') { try { args = JSON.parse(args); } catch { throw new Error('Ollama returned invalid tool arguments. Retry the request.'); } }
    return { id: tc.id || `call_${Math.random().toString(36).slice(2)}`, name: tc.function?.name || tc.name, arguments: normalizeToolArgs(args) };
  });
  if (calls.length) return { content: msg.content || '', tool_calls: calls };
  const fallback = parseToolCallsFallback(msg.content || '');
  if (fallback) return { content: '', tool_calls: fallback };
  if (msg.content?.trim()) return { content: msg.content, tool_calls: null };
  return null; // Thinking is never a final answer or an executable tool call.
}
const OLLAMA_TOOL_RECOVERY_PROMPT = 'Your previous tool call was malformed and was not executed. Retry exactly one tool using <tool_call>{"name":"read","arguments":{"filePath":"path/from/project"}}</tool_call>. Use valid JSON, escape newlines inside string values, and include no prose.';
function isOllamaToolProtocolError(value) {
  return /(?:parsing|parse|invalid|malformed)[^\n]{0,50}tool|tool[^\n]{0,50}(?:json|arguments)|unexpected end of json/i.test(String(value || ''));
}
function hasMalformedToolIntent(content) {
  const text = String(content || '');
  return (/<tool_call>/i.test(text) || /\{\s*"name"\s*:/i.test(text)) && !parseToolCallsFallback(text);
}
function normalizeToolArgs(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return args;
  const out = {};
  for (const [k, v] of Object.entries(args)) {
    if (v && typeof v === 'object' && 'content' in v && typeof v.content === 'string' && 'type' in v) out[k] = v.content;
    else if (v && typeof v === 'object' && v !== null && !Array.isArray(v) && typeof v.value === 'string') out[k] = v.value;
    else out[k] = v;
  }
  return out;
}
function extractJsonObjectsWithName(content) {
  const out = [];
  let idx = 0;
  while (true) {
    const start = content.indexOf('{"name"', idx);
    if (start === -1) break;
    let depth = 0, end = -1, inStr = false, esc = false;
    for (let i = start; i < content.length; i++) {
      const ch = content[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
      } else {
        if (ch === '"') inStr = true;
        else if (ch === '{') depth++;
        else if (ch === '}') {
          depth--;
          if (depth === 0) { end = i; break; }
        }
      }
    }
    if (end === -1) break;
    const slice = content.slice(start, end + 1);
    try {
      const obj = JSON.parse(slice);
      if (obj && typeof obj.name === 'string' && obj.arguments) {
        out.push({ id: 'call_' + Math.random().toString(36).slice(2, 8), name: obj.name, arguments: normalizeToolArgs(obj.arguments) });
        idx = end + 1;
        continue;
      }
    } catch {}
    idx = start + 1;
  }
  return out;
}
function parseToolCallsFallback(content) {
  if (!content || typeof content !== 'string') return null;
  // 1. all <tool_call> blocks
  const toolTagMatches = [...content.matchAll(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g)];
  if (toolTagMatches.length) {
    const calls = [];
    for (const m of toolTagMatches) {
      try {
        const obj = JSON.parse(m[1].trim());
        if (obj.name && obj.arguments) calls.push({ id: 'call_' + Math.random().toString(36).slice(2, 8), name: obj.name, arguments: normalizeToolArgs(obj.arguments) });
        else if (Array.isArray(obj)) for (const o of obj) if (o.name && o.arguments) calls.push({ id: 'call_' + Math.random().toString(36).slice(2, 8), name: o.name, arguments: normalizeToolArgs(o.arguments) });
      } catch {}
    }
    if (calls.length) return calls;
  }
  // 2. ```json blocks — may contain single object or array or multiple concatenated
  const codeBlocks = [...content.matchAll(/```(?:json)?\s*([\s\S]*?)\s*```/g)];
  for (const m of codeBlocks) {
    const inner = m[1].trim();
    if (!inner) continue;
    try {
      const obj = JSON.parse(inner);
      if (obj.name && obj.arguments) return [{ id: 'call_' + Math.random().toString(36).slice(2, 8), name: obj.name, arguments: normalizeToolArgs(obj.arguments) }];
      if (Array.isArray(obj) && obj[0]?.name) return obj.map(o => ({ id: 'call_' + Math.random().toString(36).slice(2, 8), name: o.name, arguments: normalizeToolArgs(o.arguments) }));
    } catch {}
    const extracted = extractJsonObjectsWithName(inner);
    if (extracted.length) return extracted;
  }
  // 3. raw content: extract all {"name":...} objects
  const rawExtracted = extractJsonObjectsWithName(content);
  if (rawExtracted.length) return rawExtracted;
  // 4. whole content as single JSON
  try {
    const obj = JSON.parse(content.trim());
    if (obj.name && obj.arguments) return [{ id: 'call_' + Math.random().toString(36).slice(2, 8), name: obj.name, arguments: normalizeToolArgs(obj.arguments) }];
    if (Array.isArray(obj) && obj[0]?.name) return obj.map(o => ({ id: 'call_' + Math.random().toString(36).slice(2, 8), name: o.name, arguments: normalizeToolArgs(o.arguments) }));
  } catch {}
  return null;
}

async function askModel({ provider, model, messages, localUrl, apiKey, context, toolsEnabled = true, requireTool = false }) {
  messages = withContext(messages, context);
  model = fixServerModel(provider, model);
  if (provider === 'local') {
    const url = `${(localUrl || process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434').replace(/\/$/, '')}/api/chat`;
    const body = ollamaBody(model, messages, toolsEnabled);
    let emptyRetries = 0;
    let toolRecoveryRetries = 0;
    while (true) {
      const response = await ollamaFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const data = await response.json();
      if (!response.ok) {
        if (body.tools && /not support tools/i.test(String(data.error))) { delete body.tools; continue; }
        if (toolsEnabled && toolRecoveryRetries < 1 && isOllamaToolProtocolError(data.error)) {
          toolRecoveryRetries++;
          delete body.tools;
          body.messages.push({ role: 'user', content: OLLAMA_TOOL_RECOVERY_PROMPT });
          continue;
        }
        throw new Error(`Ollama HTTP ${response.status}: ${data.error || 'Model request failed'}`);
      }
      let result;
      try { result = parseOllamaReply(data); }
      catch (error) {
        if (!toolsEnabled || toolRecoveryRetries >= 1 || !isOllamaToolProtocolError(error?.message)) throw error;
        toolRecoveryRetries++;
        delete body.tools;
        body.messages.push({ role: 'user', content: OLLAMA_TOOL_RECOVERY_PROMPT });
        continue;
      }
      if (result && toolsEnabled && !result.tool_calls && hasMalformedToolIntent(result.content)) {
        if (toolRecoveryRetries >= 1) throw new Error('Ollama returned malformed tool JSON twice. No incomplete file change was executed. Retry with a shorter request or a stronger tool-calling model.');
        toolRecoveryRetries++;
        delete body.tools;
        body.messages.push({ role: 'user', content: OLLAMA_TOOL_RECOVERY_PROMPT });
        continue;
      }
      if (result) return result;
      if (emptyRetries++ === 0) {
        body.messages.push({ role: 'user', content: 'Return a final answer or a tool call for the pending request. Do not repeat tools already completed.' });
        continue;
      }
      throw new Error(`Ollama (${model}) returned no answer or tool call after one retry (reason: ${data.done_reason || 'empty response'}). Try a shorter conversation or another installed model. Existing edits are preserved.`);
    }
  }
  if (provider === 'anthropic') {
    const key = apiKey || process.env.ANTHROPIC_API_KEY;
    if (!key) throw new Error('Add an Anthropic API key in settings or set ANTHROPIC_API_KEY in .env');
    const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
    const chat = anthropicMessages(messages);
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model, max_tokens: 8192,
        ...(system ? { system } : {}),
        ...(toolsEnabled ? { tools: anthropicTools(), ...(requireTool ? { tool_choice: { type: 'any' } } : {}) } : {}),
        messages: chat
      })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(`Anthropic HTTP ${response.status}: ${data.error?.message || 'Model request failed'}`);
    const blocks = data.content || [];
    const toolCalls = blocks.filter(b => b.type === 'tool_use').map(b => ({ id: b.id, name: b.name, arguments: b.input || {} }));
    const text = blocks.filter(b => b.type === 'text').map(b => b.text).join('\n') || '';
    if (toolCalls.length) return { content: text, tool_calls: toolCalls };
    if (!text.trim()) throw new Error('Anthropic returned no answer. Retry or select another model.');
    return { content: text, tool_calls: null };
  }
  if (provider === 'gemini') {
    const key = apiKey || process.env.GEMINI_API_KEY;
    if (!key) throw new Error('Add a Gemini API key in settings or set GEMINI_API_KEY in .env');
    const systemText = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        ...(systemText ? { systemInstruction: { parts: [{ text: systemText }] } } : {}),
        contents: geminiContents(messages),
        ...(toolsEnabled ? { tools: geminiTools(), toolConfig: { functionCallingConfig: { mode: requireTool ? 'ANY' : 'AUTO' } } } : {})
      })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(`Gemini HTTP ${response.status}: ${data.error?.message || 'Model request failed'}`);
    const parts = data.candidates?.[0]?.content?.parts || [];
    const toolCalls = parts.filter(part => part.functionCall).map(part => ({
      id: `call_${Math.random().toString(36).slice(2, 8)}`,
      name: part.functionCall.name,
      arguments: normalizeToolArgs(part.functionCall.args || {}),
      ...(part.thoughtSignature ? { thought_signature: part.thoughtSignature } : {})
    }));
    const text = parts.filter(part => !part.thought).map(part => part.text || '').join('').trim();
    if (toolCalls.length) return { content: text, tool_calls: toolCalls };
    const fallback = parseToolCallsFallback(text);
    if (fallback) return { content: '', tool_calls: fallback };
    if (!text) throw new Error(`Gemini returned no answer (${data.promptFeedback?.blockReason || data.candidates?.[0]?.finishReason || 'empty response'}). Retry or choose another model.`);
    return { content: text, tool_calls: null };
  }
  if (provider === 'openai') {
    const key = apiKey || process.env.OPENAI_API_KEY;
    if (!key) throw new Error('Add an OpenAI API key in settings or set OPENAI_API_KEY in .env');
    return chatCompletion('OpenAI', 'https://api.openai.com/v1', key, model, messages, toolsEnabled, requireTool);
  }
  if (OPENAI_COMPATIBLE[provider]) {
    const [base, env] = OPENAI_COMPATIBLE[provider];
    const key = apiKey || process.env[env];
    if (!key) throw new Error(`Add an API key in settings or set ${env} in .env`);
    return chatCompletion(provider, base, key, model, messages, toolsEnabled, requireTool);
  }
  throw new Error(`Unknown provider: ${provider}`);
}

const DOWNLOAD_ASSETS = {
  macos: 'CodePlus-macOS-arm64.dmg',
  windows: 'CodePlus-windows-x64-setup.exe'
};
function downloadAssetPlatform(assetName) {
  const name = String(assetName || '').toLowerCase();
  if (name === DOWNLOAD_ASSETS.macos.toLowerCase() || (name.includes('codeplus') && name.endsWith('.dmg') && /(macos|aarch64|arm64)/.test(name))) return 'macos';
  if (name === DOWNLOAD_ASSETS.windows.toLowerCase() || (name.includes('codeplus') && name.endsWith('.exe') && /(windows|win32|x64|setup)/.test(name))) return 'windows';
  return '';
}
async function githubDownloadSummary() {
  const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'CodePlus-download-counter' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const response = await fetch('https://api.github.com/repos/naylinhtunit/CodePlus-Releases/releases?per_page=100', { headers });
  if (!response.ok) throw Object.assign(new Error(`GitHub releases request failed (${response.status}).`), { status: response.status });
  const releases = (await response.json()).filter(release => !release.draft);
  const counts = { macos: 0, windows: 0 };
  const urls = {};
  const found = { macos: false, windows: false };
  for (const release of releases) {
    for (const asset of release.assets || []) {
      const platform = downloadAssetPlatform(asset.name);
      if (!platform) continue;
      found[platform] = true;
      counts[platform] += Number(asset.download_count) || 0;
      if (!urls[platform] && asset.browser_download_url) urls[platform] = asset.browser_download_url;
    }
  }
  for (const platform of Object.keys(counts)) if (!found[platform]) counts[platform] = null;
  return { counts, urls };
}

const mime = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.webp': 'image/webp', '.ico': 'image/x-icon', '.dmg': 'application/x-apple-diskimage', '.exe': 'application/vnd.microsoft.portable-executable', '.msi': 'application/x-msi' };
const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'POST' && req.url === '/api/preview/inspect') {
      const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
      if (!local || (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host)) return json(res, 403, { error: 'Preview inspection is available only to the local CodePlus server.' });
      return json(res, 200, await inspectPreview(await body(req)));
    }
    if (req.method === 'POST' && req.url === '/api/chat') {
      const input = await body(req);
      const result = await askModel(input);
      if (typeof result === 'string') return json(res, 200, { answer: result });
      return json(res, 200, { answer: result.content, tool_calls: result.tool_calls || null });
    }
    if (req.method === 'GET' && req.url === '/api/download-counts') {
      try {
        const summary = await githubDownloadSummary();
        res.setHeader('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
        return json(res, 200, summary);
      } catch (error) {
        return json(res, error.status || 502, { error: error.message, counts: { macos: null, windows: null } });
      }
    }
    if (req.method === 'POST' && req.url?.startsWith('/api/workspace/')) {
      const input = await body(req);
      if (req.url === '/api/workspace/tree') return json(res, 200, { files: await listWorkspaceTree(input.root) });
      if (req.url === '/api/workspace/read') return json(res, 200, { content: await readWorkspaceFile(input.root, input.relative) });
      if (req.url === '/api/workspace/write') {
        await writeWorkspaceFile(input.root, input.relative, input.content);
        return json(res, 200, { ok: true });
      }
      if (req.url === '/api/workspace/create-dir') return json(res, 200, { root: await createWorkspaceDirectory(input.parent, input.name) });
      return json(res, 404, { error: 'Unknown workspace operation.' });
    }
    if (req.method === 'POST' && req.url === '/api/exec') {
      const { root: cwd, command } = await body(req);
      if (typeof command !== 'string' || !command.trim()) return json(res, 400, { error: 'Enter a command to run.' });
      exec(command, { cwd: cwd || process.cwd(), timeout: 30000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
        let output = String(stdout || '');
        if (stderr) output += (output ? '\n' : '') + '[stderr]\n' + String(stderr);
        const exitCode = Number.isInteger(error?.code) ? error.code : error ? 1 : 0;
        json(res, 200, { output: output.slice(0, 60000), exitCode, timedOut: Boolean(error?.killed) });
      });
      return;
    }
    if (req.method === 'POST' && req.url === '/api/vscode/web') {
      const { acceptLicense } = await body(req);
      if (!acceptLicense) return json(res, 400, { error: 'Accept the VS Code Server license terms to continue.' });
      return json(res, 200, await startVSCodeWeb());
    }
    if (req.url?.startsWith('/api/models')) {
      if (req.method === 'POST' && req.url === '/api/models/pull') {
        const input = await body(req);
        return streamPullLocalModel(res, input.endpoint, input.model);
      }
      if (req.method === 'POST' && req.url === '/api/models/delete') {
        const input = await body(req);
        return json(res, 200, await deleteLocalModel(input.endpoint, input.model));
      }
      const endpoint = new URL(req.url, `http://${req.headers.host}`).searchParams.get('endpoint') || undefined;
      return json(res, 200, { models: await listLocalModels(endpoint) });
    }
    if (req.method === 'POST' && req.url === '/api/provider-models') {
      try {
        const input = await body(req);
        return json(res, 200, { models: await listProviderModels(String(input.provider || ''), input.apiKey || '') });
      } catch (error) {
        return json(res, error.status || 500, { error: error.message || 'Could not fetch provider models' });
      }
    }
    if (req.url?.startsWith('/api/openrouter')) {
      // Compatibility for older web clients; new clients use /api/provider-models.
      const auth = req.headers.authorization || '';
      const key = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
      try { return json(res, 200, { models: await listProviderModels('openrouter', key) }); }
      catch (error) { return json(res, error.status || 500, { error: error.message || 'Could not fetch OpenRouter models' }); }
    }
        if (req.url === '/api/status') return json(res, 200, {
      openai: Boolean(process.env.OPENAI_API_KEY), gemini: Boolean(process.env.GEMINI_API_KEY),
      keys: Object.fromEntries([['openai','OPENAI_API_KEY'],['anthropic','ANTHROPIC_API_KEY'],['gemini','GEMINI_API_KEY'],...Object.entries(OPENAI_COMPATIBLE).map(([id,[,env]]) => [id, env])].map(([id, env]) => [id, Boolean(process.env[env])])),
      local: process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434'
    });
    if (req.url === '/api/version') {
      try {
        const pkg = JSON.parse(require('node:fs').readFileSync(path.join(root, 'package.json'), 'utf8'));
        return json(res, 200, { version: pkg.version || '0.1.0' });
      } catch { return json(res, 200, { version: '0.1.0' }); }
    }
    if (req.url === '/api/version') {
      try {
        const pkg = JSON.parse(require('node:fs').readFileSync(path.join(root, 'package.json'), 'utf8'));
        return json(res, 200, { version: pkg.version || '0.1.0' });
      } catch { return json(res, 200, { version: '0.1.0' }); }
    }
    if (req.url?.startsWith('/api/dev')) {
      if (req.method === 'POST' && req.url === '/api/dev/start') {
        const { root } = await body(req);
        return json(res, 200, await startDevServer(root));
      }
      if (req.method === 'POST' && req.url === '/api/dev/stop') {
        const { root } = await body(req);
        return json(res, 200, { stopped: stopDevServer(root) });
      }
      if (req.url?.startsWith('/api/dev/status')) {
        const rootParam = new URL(req.url, `http://${req.headers.host}`).searchParams.get('root') || '';
        const absRoot = rootParam ? path.resolve(rootParam) : '';
        const child = absRoot ? devServers.get(absRoot) : null;
        let running = Boolean(child && !child.killed);
        let url = running ? child.url : null;
        if (!running) {
          // also detect a dev server that was started manually in a terminal
          const ports = [...new Set([absRoot ? detectDevPort(absRoot) : null, 3000, 5173].filter(Boolean))];
          for (const port of ports) {
            try {
              const r = await fetch(`http://127.0.0.1:${port}/`, { method: 'HEAD', signal: AbortSignal.timeout(1000) });
              if (r.ok || (r.status >= 200 && r.status < 500)) { running = true; url = `http://localhost:${port}/`; break; }
            } catch {}
          }
        }
        return json(res, 200, { running, url });
      }
    }
    if (req.url === '/api/pick-folder' && req.method === 'GET') {
      try {
        let out = '';
        if (process.platform === 'darwin') {
          out = execSync('osascript -e \'POSIX path of (choose folder with prompt "Pick project folder for CodePlus preview")\'', { encoding: 'utf8', timeout: 60000 }).trim();
        } else if (process.platform === 'win32') {
          const ps = 'Add-Type -AssemblyName System.Windows.Forms; $f=New-Object System.Windows.Forms.FolderBrowserDialog; $f.ShowDialog()|Out-Null; $f.SelectedPath';
          out = execSync(`powershell -command "${ps.replace(/"/g, '\\"')}"`, { encoding: 'utf8', timeout: 60000 }).trim();
        } else {
          out = execSync('zenity --file-selection --directory 2>/dev/null', { encoding: 'utf8', timeout: 60000 }).trim();
        }
        return json(res, 200, { path: out || null });
      } catch { return json(res, 200, { path: null }); }
    }
    if (req.url?.startsWith('/api/find-project')) {
      const name = new URL(req.url, `http://${req.headers.host}`).searchParams.get('name') || '';
      const clean = name.replace(/[\\/]/g, '').trim();
      if (!clean) return json(res, 200, { path: null });
      const searchRoots = ['Projects', 'projects', 'dev', 'code', 'Desktop', 'Documents'].map(dir => path.join(os.homedir(), dir));
      for (const base of searchRoots) {
        let entries = [];
        try { entries = require('node:fs').readdirSync(base, { withFileTypes: true }); } catch { continue; }
        const match = entries.find(e => e.isDirectory() && e.name.toLowerCase() === clean.toLowerCase());
        if (match) {
          const candidate = path.join(base, match.name);
          if (existsSync(path.join(candidate, 'package.json'))) return json(res, 200, { path: candidate });
        }
      }
      return json(res, 200, { path: null });
    }
    let rawPath = decodeURIComponent(req.url.split('?')[0]);
    if (rawPath === '/app' || rawPath.startsWith('/app/')) rawPath = '/index.html';
    const safePath = rawPath === '/' ? '/index.html' : rawPath;
    if (safePath.startsWith('/downloads/')) {
      const dlBase = path.join(root, 'downloads');
      const dlTarget = path.normalize(path.join(dlBase, safePath.slice('/downloads/'.length)));
      if (!dlTarget.startsWith(dlBase)) return json(res, 403, { error: 'Forbidden' });
      const info = await stat(dlTarget);
      if (!info.isFile()) return json(res, 404, { error: 'Not found' });
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${path.basename(dlTarget)}"` });
      return res.end(await readFile(dlTarget));
    }
    const target = path.normalize(path.join(root, 'public', safePath));
    if (!target.startsWith(path.join(root, 'public'))) return json(res, 403, { error: 'Forbidden' });
    const info = await stat(target);
    if (!info.isFile()) return json(res, 404, { error: 'Not found' });
    const type = mime[path.extname(target)] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type });
    res.end(await readFile(target));
  } catch (error) {
    if (error?.code === 'ENOENT') return json(res, 404, { error: 'Not found' });
    const message = error?.message || 'Unexpected error';
    const clientError = error instanceof SyntaxError || /^(Invalid workspace path|Workspace root is required|Workspace path escaped|Workspace path resolves outside|Invalid project name|File content|Not a file|File is too large)/.test(message);
    if (!clientError) console.error(error);
    json(res, clientError ? 400 : 500, { error: message });
  }
});

server.listen(port, '127.0.0.1', () => console.log(`CodePlus ready at http://127.0.0.1:${port}`));
