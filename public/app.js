import { renderWorkspace, listen } from './workspace-dom.js';
import { apiHistory, modelError } from './agent-history.js';
import { createToolAudit, guardToolCall, recordToolResult, needsRequirementReview, requirementReviewMessage, requestContract, toolLoopKey, normalizeToolName, needsActionReview, actionReviewMessage } from './agent-turn.js';
import { casualHistory, promptNeedsTools, promptRequestsMutation } from './prompt-intent.js';

const initialFiles = {
  'package.json': `{\n  "name": "codeplus-starter",\n  "version": "0.1.0",\n  "private": true,\n  "scripts": {\n    "dev": "next dev --turbopack",\n    "build": "next build",\n    "start": "next start"\n  },\n  "dependencies": {\n    "next": "15.3.0",\n    "react": "19.0.0",\n    "react-dom": "19.0.0"\n  },\n  "devDependencies": {\n    "typescript": "^5",\n    "@types/node": "^20",\n    "@types/react": "^19",\n    "@types/react-dom": "^19"\n  }\n}`,
  'next.config.mjs': `/** @type {import('next').NextConfig} */\nconst nextConfig = {};\nexport default nextConfig;`,
  'tsconfig.json': `{\n  "compilerOptions": {\n    "lib": ["dom", "dom.iterable", "esnext"],\n    "allowJs": true,\n    "skipLibCheck": true,\n    "strict": true,\n    "noEmit": true,\n    "esModuleInterop": true,\n    "module": "esnext",\n    "moduleResolution": "bundler",\n    "resolveJsonModule": true,\n    "isolatedModules": true,\n    "jsx": "preserve",\n    "incremental": true,\n    "plugins": [{ "name": "next" }],\n    "paths": { "@/*": ["./src/*"] }\n  },\n  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],\n  "exclude": ["node_modules"]\n}`,
  'src/app/layout.tsx': `import './globals.css';\nexport default function RootLayout({ children }: { children: React.ReactNode }) {\n  return (\n    <html lang="en">\n      <body>{children}</body>\n    </html>\n  );\n}`,
  'src/app/page.tsx': `export default function Home() {\n  return (\n    <main className="hero">\n      <span className="eyebrow">CODEPLUS</span>\n      <h1>Build faster with your own AI stack.</h1>\n      <p>One focused workspace for browser and desktop.</p>\n      <div className="actions">\n        <button>Start building</button>\n        <button className="secondary">View docs</button>\n      </div>\n    </main>\n  );\n}`,
  'src/app/globals.css': `:root {\n  color-scheme: dark;\n  --ink: #f8faff;\n  --muted: #a8b0ca;\n  --line: rgba(255, 255, 255, 0.13);\n  --violet: #8f7cff;\n  --blue: #54a8ff;\n}\n\n* { box-sizing: border-box; }\n\nhtml, body { min-height: 100%; }\n\nbody {\n  margin: 0;\n  color: var(--ink);\n  background: #090b13;\n  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;\n}\n\nbutton { font: inherit; }\n\n.hero {\n  position: relative;\n  isolation: isolate;\n  display: flex;\n  min-height: 100svh;\n  flex-direction: column;\n  align-items: center;\n  justify-content: center;\n  overflow: hidden;\n  padding: 4rem 2rem;\n  text-align: center;\n  background:\n    radial-gradient(circle at 50% 18%, rgba(84, 168, 255, 0.18), transparent 34%),\n    radial-gradient(circle at 82% 82%, rgba(143, 124, 255, 0.22), transparent 34%),\n    linear-gradient(145deg, #0d1220 0%, #090b13 58%, #10101d 100%);\n}\n\n.hero::before {\n  position: absolute;\n  inset: 0;\n  z-index: -2;\n  content: "";\n  opacity: 0.26;\n  background-image:\n    linear-gradient(var(--line) 1px, transparent 1px),\n    linear-gradient(90deg, var(--line) 1px, transparent 1px);\n  background-size: 44px 44px;\n  mask-image: linear-gradient(to bottom, black, transparent 78%);\n}\n\n.hero::after {\n  position: absolute;\n  z-index: -1;\n  width: min(72vw, 36rem);\n  aspect-ratio: 1;\n  border: 1px solid rgba(143, 124, 255, 0.24);\n  border-radius: 50%;\n  content: "";\n  box-shadow:\n    0 0 0 4rem rgba(84, 168, 255, 0.025),\n    0 0 0 9rem rgba(143, 124, 255, 0.018);\n}\n\n.eyebrow {\n  display: inline-flex;\n  align-items: center;\n  gap: 0.55rem;\n  margin-bottom: 1.35rem;\n  padding: 0.5rem 0.8rem;\n  border: 1px solid rgba(143, 124, 255, 0.32);\n  border-radius: 999px;\n  color: #c8c0ff;\n  background: rgba(143, 124, 255, 0.1);\n  font-size: 0.7rem;\n  font-weight: 800;\n  letter-spacing: 0.18em;\n}\n\n.eyebrow::before {\n  width: 0.42rem;\n  height: 0.42rem;\n  border-radius: 50%;\n  background: #78d4ff;\n  box-shadow: 0 0 14px #54a8ff;\n  content: "";\n}\n\nh1 {\n  max-width: 780px;\n  margin: 0;\n  font-size: clamp(2.7rem, 7vw, 5.6rem);\n  font-weight: 800;\n  line-height: 0.96;\n  letter-spacing: -0.065em;\n  background: linear-gradient(110deg, #ffffff 18%, #bcdcff 52%, #b8adff 86%);\n  background-clip: text;\n  -webkit-background-clip: text;\n  color: transparent;\n}\n\np {\n  max-width: 560px;\n  margin: 1.4rem 0 0;\n  color: var(--muted);\n  font-size: clamp(1rem, 2vw, 1.15rem);\n  line-height: 1.7;\n}\n\n.actions {\n  display: flex;\n  flex-wrap: wrap;\n  justify-content: center;\n  gap: 0.8rem;\n  margin-top: 2rem;\n}\n\n.actions button {\n  min-width: 9rem;\n  padding: 0.82rem 1.15rem;\n  border: 1px solid transparent;\n  border-radius: 0.85rem;\n  color: #090b13;\n  background: linear-gradient(135deg, #ffffff, #bcdcff);\n  box-shadow: 0 12px 32px rgba(84, 168, 255, 0.18);\n  font-size: 0.9rem;\n  font-weight: 750;\n  cursor: pointer;\n  transition: transform 160ms ease, box-shadow 160ms ease;\n}\n\n.actions button:hover {\n  transform: translateY(-2px);\n  box-shadow: 0 16px 38px rgba(84, 168, 255, 0.28);\n}\n\n.actions .secondary {\n  border-color: var(--line);\n  color: #e8ebf6;\n  background: rgba(255, 255, 255, 0.055);\n  box-shadow: none;\n  backdrop-filter: blur(12px);\n}\n\n@media (max-width: 520px) {\n  .hero { padding: 2.5rem 1.2rem; }\n  h1 { font-size: clamp(2.55rem, 13vw, 4rem); }\n  p { font-size: 0.96rem; }\n  .actions { width: min(100%, 19rem); }\n  .actions button { flex: 1 1 100%; }\n}`,
  'src/components/assistant.tsx': `export function Assistant() {\n  return <aside>Ask your selected AI provider</aside>;\n}`,
  'README.md': `# CodePlus project\n\nBuilt with CodePlus. Choose a local, Codex, or Gemini model in Studio settings.\n\n## Run\n\n\`\`\`bash\nnpm install\nnpm run dev\n\`\`\`\nOpen http://localhost:3000 — preview in CodePlus will show the same page.\n`,
  '.env.local': `# Never commit keys\nOPENAI_API_KEY=\nGEMINI_API_KEY=`
};
const localModelCatalog = [
  { name: 'qwen3-coder:30b', title: 'Qwen3 Coder 30B A3B', size: '18 GB', description: 'Agentic coding specialist with strong tool calling.' },
  { name: 'qwen2.5-coder:7b', title: 'Qwen2.5 Coder 7B', size: '4.7 GB', description: 'Code generation, repair, and explanations.' },
  { name: 'qwen2.5-coder:3b', title: 'Qwen2.5 Coder 3B', size: '1.9 GB', description: 'Lightweight coding helper for smaller machines.' },
  { name: 'codellama:13b', title: 'Code Llama 13B', size: '7.4 GB', description: 'Classic open coding model from Meta.' },
  { name: 'starcoder2:3b', title: 'StarCoder2 3B', size: '1.7 GB', description: 'Fast autocomplete-style code completions.' },
  { name: 'qwen3:8b', title: 'Qwen3 8B', size: '5.2 GB', description: 'Strong everyday coding and multilingual help.' },
  { name: 'qwen3:4b', title: 'Qwen3 4B', size: '2.5 GB', description: 'A capable choice for laptops with less memory.' },
  { name: 'qwen3:14b', title: 'Qwen3 14B', size: '9.3 GB', description: 'Higher quality answers when RAM allows it.' },
  { name: 'qwen3:30b-a3b', title: 'Qwen3 30B A3B', size: '18 GB', description: 'Big MoE model that stays fast on active tokens.' },
  { name: 'llama3.2:3b', title: 'Llama 3.2 3B', size: '2.0 GB', description: 'Fast general assistant for lighter machines.' },
  { name: 'llama3.2:1b', title: 'Llama 3.2 1B', size: '1.3 GB', description: 'Tiny model for quick drafts on any Mac.' },
  { name: 'llama3.1:8b', title: 'Llama 3.1 8B', size: '4.9 GB', description: 'Reliable all-round open model from Meta.' },
  { name: 'gemma3:1b', title: 'Gemma 3 1B', size: '815 MB', description: 'Google mini model with surprisingly good text quality.' },
  { name: 'gemma3:4b', title: 'Gemma 3 4B', size: '3.3 GB', description: 'Balanced local chat, writing, and reasoning.' },
  { name: 'gemma3:12b', title: 'Gemma 3 12B', size: '8.1 GB', description: 'Mid-size Gemma with stronger reasoning.' },
  { name: 'gemma3:27b', title: 'Gemma 3 27B', size: '17 GB', description: 'Large Gemma tier for capable workstations.' },
  { name: 'gpt-oss:20b', title: 'GPT-OSS 20B', size: '14 GB', description: 'OpenAI open-weight model with reasoning controls.' },
  { name: 'gpt-oss:120b', title: 'GPT-OSS 120B', size: '65 GB', description: 'Flagship open-weight tier for high-end machines.' },
  { name: 'phi4-mini', title: 'Phi-4 Mini', size: '2.5 GB', description: 'Compact model for quick local tasks.' },
  { name: 'phi4', title: 'Phi-4 14B', size: '9.1 GB', description: 'Microsoft model with strong math and logic.' },
  { name: 'deepseek-r1:8b', title: 'DeepSeek R1 8B', size: '5.2 GB', description: 'Reasoning-focused model for tougher problems.' },
  { name: 'deepseek-r1:14b', title: 'DeepSeek R1 14B', size: '9.0 GB', description: 'Deeper reasoning chains than the 8B variant.' },
  { name: 'deepseek-r1:32b', title: 'DeepSeek R1 32B', size: '20 GB', description: 'Heavy-duty reasoning for complex refactors.' },
  { name: 'deepseek-coder-v2:16b', title: 'DeepSeek Coder V2 16B', size: '8.9 GB', description: 'MoE coder covering 300+ languages.' },
  { name: 'mistral:7b', title: 'Mistral 7B', size: '4.1 GB', description: 'Efficient classic that still holds up well.' },
  { name: 'mistral-nemo', title: 'Mistral Nemo 12B', size: '7.1 GB', description: 'Multilingual model from Mistral and NVIDIA.' },
  { name: 'glm4:9b', title: 'GLM 4 9B', size: '5.5 GB', description: 'Bilingual chat and code from Zhipu AI.' },
  { name: 'smollm2:1.7b', title: 'SmolLM2 1.7B', size: '1.8 GB', description: 'Very small Hugging Face model for low specs.' },
  { name: 'tinyllama', title: 'TinyLlama 1.1B', size: '638 MB', description: 'Smallest option; instant responses on anything.' }
];
const PROVIDERS = [
  { id: 'local', name: 'Ollama (local)', group: 'Local' },
  { id: 'openai', name: 'OpenAI / Codex', group: 'Cloud', env: 'OPENAI_API_KEY', model: 'gpt-5', access: 'paid', accessNote: 'Paid API models — OpenAI API credits are required.', keyUrl: 'https://platform.openai.com/api-keys', modelsUrl: 'https://platform.openai.com/docs/models', models: [{id:'gpt-5',name:'GPT-5'},{id:'gpt-5-mini',name:'GPT-5 mini'},{id:'gpt-4.1',name:'GPT-4.1'},{id:'o4-mini',name:'o4-mini'}] },
  { id: 'anthropic', name: 'Anthropic Claude', group: 'Cloud', env: 'ANTHROPIC_API_KEY', model: 'claude-sonnet-4-5', access: 'paid', accessNote: 'Paid API models — Anthropic usage credits are required.', keyUrl: 'https://console.anthropic.com/settings/keys', modelsUrl: 'https://docs.anthropic.com/en/docs/about-claude/models/overview', models: [{id:'claude-sonnet-4-5',name:'Claude Sonnet 4.5'},{id:'claude-opus-4-5',name:'Claude Opus 4.5'},{id:'claude-haiku-4-5',name:'Claude Haiku 4.5'}] },
  { id: 'gemini', name: 'Google Gemini', group: 'Cloud', env: 'GEMINI_API_KEY', model: 'gemini-3.6-flash', access: 'limited-free', accessNote: 'Limited free tier — quota and model access depend on your Google project and account.', keyUrl: 'https://aistudio.google.com/app/apikey', modelsUrl: 'https://ai.google.dev/gemini-api/docs/models', models: [{id:'gemini-3.6-flash',name:'Gemini 3.6 Flash',free:true},{id:'gemini-3.5-flash-lite',name:'Gemini 3.5 Flash-Lite',free:true}] },
  { id: 'groq', name: 'Groq', group: 'Cloud', env: 'GROQ_API_KEY', model: 'llama-3.3-70b-versatile', keyUrl: 'https://console.groq.com/keys', modelsUrl: 'https://console.groq.com/docs/models', models: [{id:'llama-3.3-70b-versatile',name:'Llama 3.3 70B Versatile',free:true},{id:'openai/gpt-oss-120b',name:'GPT-OSS 120B',free:true},{id:'openai/gpt-oss-20b',name:'GPT-OSS 20B',free:true}] },
  { id: 'deepseek', name: 'DeepSeek', group: 'Cloud', env: 'DEEPSEEK_API_KEY', model: 'deepseek-chat', keyUrl: 'https://platform.deepseek.com/api_keys', modelsUrl: 'https://api-docs.deepseek.com/quick_start/pricing', models: [{id:'deepseek-chat',name:'DeepSeek Chat'},{id:'deepseek-reasoner',name:'DeepSeek Reasoner'}] },
  { id: 'mistral', name: 'Mistral AI', group: 'Cloud', env: 'MISTRAL_API_KEY', model: 'mistral-large-latest', keyUrl: 'https://console.mistral.ai/api-keys', modelsUrl: 'https://docs.mistral.ai/models', models: [{id:'mistral-large-latest',name:'Mistral Large'},{id:'mistral-small-latest',name:'Mistral Small'},{id:'codestral-latest',name:'Codestral'}] },
  { id: 'xai', name: 'xAI Grok', group: 'Cloud', env: 'XAI_API_KEY', model: 'grok-4', keyUrl: 'https://console.x.ai/team/default/api-keys', modelsUrl: 'https://docs.x.ai/developers/models', models: [{id:'grok-4',name:'Grok 4'},{id:'grok-3',name:'Grok 3'},{id:'grok-3-mini',name:'Grok 3 Mini'}] },
  { id: 'openrouter', name: 'OpenRouter', group: 'Cloud', env: 'OPENROUTER_API_KEY', model: 'qwen/qwen3-coder:free', keyUrl: 'https://openrouter.ai/settings/keys', modelsUrl: 'https://openrouter.ai/models', models: [{id:'qwen/qwen3-coder:free',name:'Qwen3 Coder (free)',pricing:{prompt:'0',completion:'0'}}] },
  { id: 'together', name: 'Together AI', group: 'Cloud', env: 'TOGETHER_API_KEY', model: 'Qwen/Qwen2.5-Coder-32B-Instruct', keyUrl: 'https://api.together.ai/settings/api-keys', modelsUrl: 'https://api.together.ai/models', models: [{id:'Qwen/Qwen2.5-Coder-32B-Instruct',name:'Qwen2.5 Coder 32B'},{id:'deepseek-ai/DeepSeek-R1',name:'DeepSeek R1'},{id:'meta-llama/Llama-3.3-70B-Instruct-Turbo',name:'Llama 3.3 70B Turbo'}] },
  { id: 'fireworks', name: 'Fireworks AI', group: 'Cloud', env: 'FIREWORKS_API_KEY', model: 'accounts/fireworks/models/kimi-k2-instruct', keyUrl: 'https://app.fireworks.ai/settings/users/api-keys', modelsUrl: 'https://fireworks.ai/models', models: [{id:'accounts/fireworks/models/kimi-k2-instruct',name:'Kimi K2 Instruct'},{id:'accounts/fireworks/models/deepseek-v3p1',name:'DeepSeek V3.1'},{id:'accounts/fireworks/models/llama-v3p3-70b-instruct',name:'Llama 3.3 70B Instruct'}] },
  { id: 'cerebras', name: 'Cerebras', group: 'Cloud', env: 'CEREBRAS_API_KEY', model: 'qwen-3-coder-480b', keyUrl: 'https://cloud.cerebras.ai/platform', modelsUrl: 'https://inference-docs.cerebras.ai/models/overview', models: [{id:'qwen-3-coder-480b',name:'Qwen 3 Coder 480B'},{id:'gpt-oss-120b',name:'GPT-OSS 120B',free:true},{id:'llama3.1-8b',name:'Llama 3.1 8B',free:true}] }
];
const providerInfo = id => PROVIDERS.find(item => item.id === id) || PROVIDERS[0];
function isFreeCloudModel(provider, model) {
  const id = String(model?.id || '');
  const name = String(model?.name || model?.displayName || '');
  const curated = (providerInfo(provider).models || []).find(item => item.id === id);
  const pricing = model?.pricing || {};
  return model?.free === true || curated?.free === true || id.endsWith(':free') || /(?:^|[\s._:/-])free(?:$|[\s._:/-])/i.test(`${id} ${name}`)
    || (String(pricing.prompt) === '0' && String(pricing.completion) === '0');
}
// opencode-inspired agent — CodePlus tools + system prompt (shared with server.mjs & main.rs)
const AGENT_TOOLS = [
  { type: 'function', function: { name: 'read', description: 'Read file content. Use to understand codebase before editing.', parameters: { type: 'object', properties: { filePath: { type: 'string', description: 'Relative path from project root' } }, required: ['filePath'] } } },
  { type: 'function', function: { name: 'write', description: 'Create new file or overwrite existing one. Use for new files; prefer edit for surgical changes.', parameters: { type: 'object', properties: { filePath: { type: 'string' }, content: { type: 'string' } }, required: ['filePath', 'content'] } } },
  { type: 'function', function: { name: 'edit', description: 'Exact string replacement in an existing file. oldString must match exactly.', parameters: { type: 'object', properties: { filePath: { type: 'string' }, oldString: { type: 'string' }, newString: { type: 'string' }, replaceAll: { type: 'boolean' } }, required: ['filePath', 'oldString', 'newString'] } } },
  { type: 'function', function: { name: 'bash', description: 'Run a shell command in the project root. Timeout 30s.', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } } },
  { type: 'function', function: { name: 'glob', description: 'Find files by glob pattern.', parameters: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] } } },
  { type: 'function', function: { name: 'grep', description: 'Search file contents with regex.', parameters: { type: 'object', properties: { pattern: { type: 'string' }, include: { type: 'string' } }, required: ['pattern'] } } },
  { type: 'function', function: { name: 'todowrite', description: 'Track progress on multi-step tasks.', parameters: { type: 'object', properties: { todos: { type: 'array', items: { type: 'object', properties: { content: { type: 'string' }, status: { type: 'string', enum: ['pending','in_progress','completed','cancelled'] }, priority: { type: 'string', enum: ['high','medium','low'] } }, required: ['content','status','priority'] } } }, required: ['todos'] } } }
];
const AGENT_SYSTEM_PROMPT = `You are CodePlus — a local-first coding agent inspired by opencode. You directly edit files on disk via tools; you do not just describe code.

Rules:
- When the user asks to build, change, fix, refactor, or test code, keep working until the requested result is implemented. Do not stop at instructions or a code sample.
- For a requested workspace change, your first response must be a tool call. Never answer with generic example code before inspecting the actual workspace.
- The latest user message is the only active task. Earlier messages and tool summaries are context only; never resume an older task unless the latest message explicitly asks you to.
- Before using tools, identify the requested outcome and every preserve/do-not-change constraint. Negative constraints are absolute, including constraints written in another language.
- Quoted UI labels identify elements; they do not imply that the element's appearance should change. For navigation or page requests, inspect routes and components before considering CSS.
- Always explore before editing: use glob/grep/read to understand the codebase and the exact files involved.
- Read every existing file in the current turn before editing or overwriting it. Never rely only on content from an older conversation turn.
- Prefer edit for surgical changes; use write only for new files or full rewrites.
- Run an appropriate check with bash after edits when the workspace supports it.
- Never claim a file changed unless write/edit returned success. If a tool fails, inspect the error and recover.
- After file edits, compare the result against the original request, re-read changed files, run an appropriate check, then briefly summarize what changed and how it was verified.
- Keep responses concise and practical. Answer in the user's language. Do not output an audit report, Markdown table, raw file contents, or an internal verification transcript unless the user asks for one. Use todowrite only for genuinely multi-step tasks.
- Files are at project root. Paths are relative (e.g. src/app/page.tsx); never use paths outside the workspace.
- If native function calling is unavailable, request tools by emitting exactly <tool_call>{"name":"read","arguments":{"filePath":"src/app/page.tsx"}}</tool_call>. Emit one block per call and no prose until tool work is complete.`;

const CASUAL_SYSTEM_PROMPT = `You are CodePlus, a friendly concise assistant. Reply directly to the user's latest conversational message in the same language. This is a normal chat turn, not a workspace task. Do not discuss, inspect, modify, or make claims about project files unless the user explicitly asks for coding work.`;

function loadSavedKey(provider) {
  try {
    const per = localStorage.getItem('codeplus-key-' + provider);
    if (per) return per;
    // fallback: legacy single key migration
    const legacy = localStorage.getItem('codeplus-api-key');
    if (legacy && provider === localStorage.getItem('codeplus-provider')) {
      localStorage.setItem('codeplus-key-' + provider, legacy);
      localStorage.removeItem('codeplus-api-key');
      return legacy;
    }
  } catch {}
  return '';
}
function saveProviderKey(provider, key) {
  const clean = String(key || '').trim();
  if (!provider || !clean) return;
  try { localStorage.setItem('codeplus-key-' + provider, clean); } catch {}
}
function removeProviderKey(provider) {
  try { localStorage.removeItem('codeplus-key-' + provider); } catch {}
}
function loadSavedModel(provider) {
  try {
    const per = localStorage.getItem('codeplus-model-' + provider);
    if (per) return per;
    if (provider === localStorage.getItem('codeplus-provider')) return localStorage.getItem('codeplus-model') || '';
  } catch {}
  return '';
}
function saveProviderModel(provider, model) {
  const clean = String(model || '').trim();
  if (!provider || !clean) return;
  try { localStorage.setItem('codeplus-model-' + provider, clean); } catch {}
}
function maskedKey(key) {
  const clean = String(key || '').trim();
  return clean ? `••••••••${clean.slice(-4)}` : '';
}
function fixInvalidModel(provider, model) {
  if (!model) return model;
  if (provider === 'openrouter' && (model === 'openrouter/free' || model === 'openrouter')) return 'moonshotai/kimi-k2';
  if (provider === 'gemini' && ['gemini-2.5-flash','models/gemini-2.5-flash'].includes(model)) return 'gemini-3.6-flash';
  return model;
}
const _savedProviderValue = localStorage.getItem('codeplus-provider') || 'local';
const _savedProvider = _savedProviderValue === 'lmstudio' ? 'local' : _savedProviderValue;
const _savedModel = fixInvalidModel(_savedProvider, _savedProviderValue === 'lmstudio' ? '' : loadSavedModel(_savedProvider));
if (_savedProviderValue !== _savedProvider) try { localStorage.setItem('codeplus-provider', _savedProvider); } catch {}
if (_savedModel) try { localStorage.setItem('codeplus-model', _savedModel); saveProviderModel(_savedProvider, _savedModel); } catch {}
try { localStorage.removeItem('codeplus-lmstudio-url'); localStorage.removeItem('codeplus-key-lmstudio'); } catch {}
const state = {
  files: structuredClone(initialFiles), active: 'src/app/page.tsx',
  provider: _savedProvider,
  model: _savedModel,
  localUrl: localStorage.getItem('codeplus-local-url') || 'http://127.0.0.1:11434',
  apiKey: loadSavedKey(_savedProvider), draftProvider: 'local', localModels: [], localModelsLoaded: false, localModelsLoading: false, localModelsError: '', pullProgress: {}, removingModel: '',
  keyDrafts: {}, keyEditing: {}, keyRemoveConfirm: '', modelDeleteConfirm: null,
  cloudModels: Object.fromEntries(PROVIDERS.filter(item=>item.group==='Cloud').map(item=>[item.id, structuredClone(item.models || [])])), cloudModelsLoaded: {}, cloudModelLoading: {}, cloudModelError: {},
  messages: [], chatHistoryKey: '', editingMessageId: '', copiedMessageId: '', sending: false, turnProvider: null, stopRequested: false, abortController: null, stopPromise: null, stopReject: null, settingsOpen: false, modelPickerOpen: false, dirty: false, dirtyFiles: new Set(), vscodeNote: '', vscodeConsent: false, vscodeView: false, vscodeUrl: '',
  folders: { src: true, 'src/app': true, 'src/components': false }, previewUrl: localStorage.getItem('codeplus-preview-url') || 'http://localhost:3000', customPreview: Boolean(localStorage.getItem('codeplus-preview-url')),
  projectName: localStorage.getItem('codeplus-project-name') || 'CodePlus', workspacesOpen: false, previewHidden: false, editorClosed: false, filesHidden: localStorage.getItem('codeplus-files-hidden') === 'true', downloadOpen: false,
  dirHandle: null, dirPath: '', treePaths: [], fileHandles: {}, loading: new Set(),
  pendingHandle: null, pendingName: '',
  plusOpen: false, attachPickerOpen: false, attached: [],
  shellOpen: false, shellBusy: false, shellOutputs: [],
  todos: [],
  draftPrompt: '',
  uploads: [], // {id, name, type, data, preview}
  devRunning: false, devStarting: false,
  updateAvailable: false, latestVersion: '', updateChecking: false, updateBusy: false, updateStage: 'idle', updateProgress: 0
};
const FS_IGNORE = new Set(['node_modules','.git','.codeplus','dist','build','target','.next','.nuxt','.venv','venv','__pycache__','.DS_Store']);
const isTextFile = name => !/\.(png|jpe?g|gif|webp|avif|ico|icns|pdf|zip|gz|tgz|bz2|xz|7z|rar|dmg|iso|exe|msi|dll|so|dylib|bin|o|a|class|jar|war|woff2?|ttf|otf|eot|mp3|wav|ogg|mp4|webm|mov|avi|mkv|sqlite|db|pdb|wasm|blend|psd|ai|sketch)$/i.test(name);
function fsMode() { return state.dirHandle ? 'fsapi' : state.dirPath ? 'native' : 'memory'; }
async function tauriInvoke(cmd, args) {
  if (window.__TAURI_INTERNALS__?.invoke) return window.__TAURI_INTERNALS__.invoke(cmd, args);
  const m = await import('@tauri-apps/api/core');
  return m.invoke(cmd, args);
}
async function serverWorkspaceRequest(action, payload) {
  const response = await fetch(`/api/workspace/${action}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Workspace ${action} failed.`);
  return data;
}
async function listWorkspaceFiles(root) {
  if (window.__TAURI_INTERNALS__) return tauriInvoke('list_workspace_tree', { root });
  return (await serverWorkspaceRequest('tree', { root })).files || [];
}
async function readWorkspaceText(root, relative) {
  if (window.__TAURI_INTERNALS__) return tauriInvoke('read_workspace_file', { root, relative });
  return (await serverWorkspaceRequest('read', { root, relative })).content ?? '';
}
async function writeWorkspaceText(root, relative, content) {
  if (window.__TAURI_INTERNALS__) return tauriInvoke('write_workspace_file', { root, relative, content });
  await serverWorkspaceRequest('write', { root, relative, content });
}
async function createWorkspaceDirectory(parent, name) {
  if (window.__TAURI_INTERNALS__) return tauriInvoke('create_workspace_dir', { parent, name });
  return (await serverWorkspaceRequest('create-dir', { parent, name })).root;
}
async function tauriListen(event, handler) {
  // The desktop frontend is copied as static files, not bundled by npm.
  // withGlobalTauri exposes the supported API without an unresolved bare import.
  if (window.__TAURI__?.event?.listen) return window.__TAURI__.event.listen(event, handler);
  throw new Error('Desktop event API unavailable. Please install the latest CodePlus desktop release.');
}
function idbStore() {
  return new Promise((resolve, reject) => {
    try {
      const request = indexedDB.open('codeplus-workspace', 1);
      request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains('kv')) request.result.createObjectStore('kv'); };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    } catch (error) { reject(error); }
  });
}
async function idbSet(key, value) { const db = await idbStore(); return new Promise((resolve, reject) => { const tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').put(value, key); tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); }); }
async function idbGet(key) { const db = await idbStore(); return new Promise((resolve, reject) => { const tx = db.transaction('kv', 'readonly'); const request = tx.objectStore('kv').get(key); request.onsuccess = () => resolve(request.result ?? null); request.onerror = () => reject(request.error); }); }
async function idbDel(key) { try { const db = await idbStore(); const tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').delete(key); } catch {} }
function messageId() { return `msg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`; }
function normalizeMessages(items) {
  return (Array.isArray(items) ? items : []).filter(item => item && typeof item === 'object' && item.role).map(item => ({
    ...item,
    id: item.id || messageId(),
    createdAt: item.createdAt || Date.now()
  }));
}
function chatHistoryStorageKey() {
  const workspace = state.dirPath ? `path:${state.dirPath}` : state.dirHandle?.name ? `folder:${state.dirHandle.name}` : `memory:${state.projectName || 'CodePlus'}`;
  return `chat-history:${workspace}`;
}
let chatSaveTimer = null;
async function flushChatHistory() {
  if (chatSaveTimer) { clearTimeout(chatSaveTimer); chatSaveTimer = null; }
  if (!state.chatHistoryKey) return;
  const payload = { version: 1, updatedAt: Date.now(), messages: structuredClone(state.messages) };
  try { await idbSet(state.chatHistoryKey, payload); } catch {}
}
function persistChatHistory() {
  const key = state.chatHistoryKey || chatHistoryStorageKey();
  state.chatHistoryKey = key;
  if (chatSaveTimer) clearTimeout(chatSaveTimer);
  const payload = { version: 1, updatedAt: Date.now(), messages: structuredClone(state.messages) };
  chatSaveTimer = setTimeout(() => {
    chatSaveTimer = null;
    idbSet(key, payload).catch(() => {});
  }, 120);
}
async function loadChatHistory() {
  const key = chatHistoryStorageKey();
  state.chatHistoryKey = key;
  state.editingMessageId = '';
  state.copiedMessageId = '';
  try {
    const saved = await idbGet(key);
    if (state.chatHistoryKey !== key) return;
    state.messages = normalizeMessages(Array.isArray(saved) ? saved : saved?.messages);
  } catch { state.messages = []; }
  app();
  scrollChatToBottom();
}
function appendMessage(message) {
  const source = state.turnProvider || state;
  const item = { id: message.id || messageId(), createdAt: message.createdAt || Date.now(), provider: source.provider, model: source.model, ...message };
  state.messages.push(item);
  persistChatHistory();
  return item;
}
async function persistWorkspaceSession() {
  localStorage.setItem('codeplus-active-file', state.active || '');
  if (state.dirHandle) await idbSet('workspace', state.dirHandle).catch(() => {});
  else if (state.dirPath) { localStorage.setItem('codeplus-dir-path', state.dirPath); idbDel('workspace'); }
  else clearWorkspaceSession();
}
function clearWorkspaceSession() { localStorage.removeItem('codeplus-active-file'); localStorage.removeItem('codeplus-dir-path'); idbDel('workspace'); }
const el = (strings, ...values) => strings.reduce((out, s, i) => out + s + (values[i] ?? ''), '');
function escape(text) { return String(text ?? '').replace(/[&<>]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;' }[c])); }
function lineNumbers(text) { return Array.from({ length: Math.max(1, text.split('\n').length) }, (_, index) => `<span>${index + 1}</span>`).join(''); }
function highlightCode(text) {
  if (text.length > 60000 || text.split('\n').length > 1200) return escape(text);
  return escape(text).replace(/(\/\/[^\n]*)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|\b(export|default|function|return|const|let|import|from|class|new|if|else|async|await|true|false|null)\b|\b(\d+(?:\.\d+)?)\b|(&lt;\/?)([A-Za-z][\w.-]*)/g, (match, comment, string, keyword, number, tagStart, tag) => {
    if (comment) return `<span class="token-comment">${comment}</span>`;
    if (string) return `<span class="token-string">${string}</span>`;
    if (keyword) return `<span class="token-keyword">${keyword}</span>`;
    if (number) return `<span class="token-number">${number}</span>`;
    return `${tagStart}<span class="token-tag">${tag}</span>`;
  });
}
function previewAddress() {
  const hasPackageJson = state.treePaths.includes('package.json');
  const canDev = hasPackageJson && fsMode() !== 'memory';
  const devBtn = canDev ? `<button type="button" id="dev-server-btn" class="icon-btn ${state.devRunning ? 'dev-running' : ''}" title="${state.devRunning ? 'Dev server running — click to stop' : state.devStarting ? 'Starting dev server…' : 'Start dev server (auto runs npm run dev)'}">${state.devStarting ? '⏳' : state.devRunning ? '⏹' : '▶'}</button>` : '';
  return `<form class="preview-head" id="preview-form"><span>◉</span>${devBtn}<input class="url" id="preview-url" value="${escape(state.previewUrl)}" aria-label="Preview URL" spellcheck="false" /><button type="submit" title="Load preview URL">↵</button><button type="button" id="open-preview" title="Open preview URL in a new tab">↗</button></form>`;
}
function fileTree() {
  const paths = fsMode()==='memory' ? Object.keys(state.files) : state.treePaths;
  const root = {};
  for (const file of paths) { let branch=root; for (const part of file.split('/')) branch=branch[part] ||= {}; branch.__file=file; }
  const icon = (name, isFolder) => isFolder ? ['', `folder ${name==='src'?'source-folder':name==='app'?'app-folder':'component-folder'}`] : name.endsWith('.tsx') ? ['⚛','file react-file'] : name.endsWith('.css') ? ['#','file css-file'] : name.endsWith('.ts') ? ['TS','file typescript-file'] : name.startsWith('.env') ? ['⚙','file config-file'] : name.endsWith('.md') ? ['ⓘ','file markdown-file'] : ['•','file'];
  const row = (chev, glyph, label, type, depth, key='', folder='') => `<div class="tree-row ${key === state.active && !state.editorClosed ? 'selected':''} ${state.dirtyFiles.has(key) ? 'changed':''}" ${key ? `data-file="${escape(key)}"` : ''} ${folder ? `data-folder="${escape(folder)}"` : ''}><span class="indent">${'&nbsp;'.repeat(depth * 2)}</span><span class="chev">${chev}</span><span class="tree-icon ${type}">${glyph}</span><span>${escape(label)}</span></div>`;
  const visit = (node, depth=0, parent='') => Object.entries(node).filter(([name]) => name !== '__file').sort(([a,aNode],[b,bNode]) => Number(Boolean(aNode.__file)) - Number(Boolean(bNode.__file)) || a.localeCompare(b)).map(([name, child]) => {
    const path=parent ? `${parent}/${name}` : name; const isFile=Boolean(child.__file); const [glyph,type]=icon(name,!isFile);
    if (isFile) return row('•',glyph,name,type,depth,child.__file);
    const open=state.folders[path] ?? true;
    return row(open?'▾':'▸',glyph,name,type,depth,'',path) + (open ? visit(child,depth+1,path) : '');
  }).join('');
  return visit(root);
}
function preview() {
  if (!state.customPreview) return `<div class="preview-card"><span class="preview-badge">CODEPLUS</span><h1>Build faster with your own AI stack.</h1><p>One focused workspace for browser and desktop. The preview updates as you edit.</p><div class="preview-actions"><button>Start building</button><button>View docs</button></div></div>`;
  const needsDev = state.treePaths.includes('package.json');
  if (needsDev && !state.devRunning && !state.devStarting) {
    return `<div class="preview-card dev-prompt"><span class="preview-badge" style="background:#1a2336;color:#8ea4ff">DEV SERVER</span><h1>Dev server not running</h1><p>Preview is set to <code>${escape(state.previewUrl)}</code> but nothing is listening there yet.</p><p style="color:#758197;font-size:12px">Run <code>npm run dev</code> in your terminal, or click Start to let CodePlus run it for you.</p><div class="preview-actions"><button id="preview-start-dev" class="primary">▶ Start dev server</button><button id="preview-reload">↻ Reload preview</button></div></div>`;
  }
  if (state.devStarting) return `<div class="preview-card"><span class="preview-badge" style="background:#1a2336;color:#8ea4ff">DEV SERVER</span><h1>Starting dev server…</h1><p>Running <code>npm run dev</code> — preview will reload automatically when ready.</p><div class="preview-actions"><button disabled>⏳ Starting…</button></div></div>`;
  return `<iframe class="preview-frame" title="Project preview" src="${escape(state.previewUrl)}"></iframe>`;
}
function messages() {
  const callsById = new Map();
  for (const message of state.messages) {
    for (const call of message.tool_calls || []) callsById.set(call.id, call);
  }
  return state.messages.map(m => {
    if (m.role === 'tool') {
      const call = callsById.get(m.tool_call_id) || { name: m.name || 'tool', arguments: {} };
      const args = call.arguments || {};
      const target = call.name === 'bash' ? args.command : call.name === 'glob' ? args.pattern : call.name === 'grep' ? `${args.pattern || ''}${args.include ? ` · ${args.include}` : ''}` : args.filePath || '';
      const labels = { read:'Read', write:'Wrote', edit:'Edited', bash:'Ran', glob:'Listed', grep:'Searched', todowrite:'Updated tasks' };
      const output = String(m.content || '');
      const blocked = /^(?:Blocked|Doom loop)/i.test(output);
      const failed = /^Error:/i.test(output) || /\[(?:exit code [1-9]|command timed out)/i.test(output);
      const status = blocked ? 'Blocked' : failed ? 'Failed' : 'Done';
      const preview = output.slice(0, 4000);
      return `<details class="message tool ${blocked?'blocked':failed?'failed':''}" data-message-id="${escape(m.id)}"><summary><span class="tool-state">${blocked?'!':failed?'×':'✓'}</span><span class="tool-label">${escape(labels[call.name] || call.name || 'Tool')}</span>${target ? `<code title="${escape(target)}">${escape(String(target).slice(0,160))}</code>` : ''}<span class="tool-status">${status}</span></summary><pre class="tool-output">${escape(preview)}${output.length>4000?'\n…':''}</pre></details>`;
    }
    const toolCalls = (m.tool_calls || []).map(tc => {
      const args = tc.arguments || {};
      const summary = tc.name === 'read' ? args.filePath : tc.name === 'write' ? args.filePath : tc.name === 'edit' ? `${args.filePath}` : tc.name === 'bash' ? args.command : tc.name === 'glob' ? args.pattern : tc.name === 'grep' ? args.pattern : JSON.stringify(args).slice(0,120);
      return `<div class="tool-call"><span class="tool-name">${escape(tc.name)}</span><span class="tool-args">${escape(String(summary||'').slice(0,160))}</span></div>`;
    }).join('');
    if (m.role === 'assistant' && m.tool_calls?.length && !m.content?.trim()) return '';
    const body = m.content ? `<div class="msg-body">${escape(m.content)}</div>` : '';
    const images = (m.images || []).map(img => `<div class="msg-image"><img src="${escape(img.image_url?.url || '')}" alt="uploaded image" /></div>`).join('');
    const copied = state.copiedMessageId === m.id;
    const copyAction = m.content ? `<button type="button" data-copy-message="${escape(m.id)}" title="Copy message" aria-label="Copy message">${copied ? '<span class="action-check">✓</span>' : '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="11" height="11" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>'}</button>` : '';
    const editAction = m.role==='user' && m.content ? `<button type="button" data-edit-message="${escape(m.id)}" title="Edit and resend" aria-label="Edit message"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 20 4.2-1 10.6-10.6a2 2 0 0 0-2.8-2.8L5.4 16.2 4 20Z"/><path d="m14.5 7.1 2.8 2.8"/></svg></button>` : '';
    const actions = copyAction || editAction ? `<div class="message-actions">${copyAction}${editAction}</div>` : '';
    const editedNote = m.editedFrom ? '<span class="edited-note">Edited copy</span>' : '';
    return `<div class="message ${m.role === 'user' ? 'user' : ''} ${m.error ? 'error':''} ${m.stopped ? 'stopped':''}" data-message-id="${escape(m.id)}"><div class="message-head"><span class="role">${m.role === 'user' ? 'You' : m.role==='assistant' ? escape(compactModelName(m.model||'agent', '', 30)) : escape(m.role)}${editedNote}</span>${actions}</div>${body}${images}${m.content?.trim() ? toolCalls : ''}</div>`;
  }).join('') + (state.todos.length ? `<div class="message todos"><span class="role">Todos</span>${state.todos.map(t=>`<div class="todo ${t.status}"><span>${t.status==='completed'?'✓':t.status==='in_progress'?'◉':'○'} ${escape(t.content)}</span><span class="prio">${escape(t.priority||'')}</span></div>`).join('')}</div>` : '');
}
function compactModelName(id, name = '', max = 38) {
  const modelId = String(id || '').trim();
  let label = String(name || '').trim();
  if (!label || label === modelId) label = modelId.split('/').pop() || modelId;
  label = label.replace(/\s*\(free\)\s*$/i, '').replace(/:free$/i, '').replace(/^[^:]{2,24}:\s+/, '').replace(/\s+/g, ' ').trim();
  return label.length > max ? `${label.slice(0, Math.max(1, max - 1)).trimEnd()}…` : label;
}
function modelOptionLabel(model, free = false, provider = state.draftProvider) {
  const paid = providerInfo(provider).access === 'paid';
  const legacy = provider === 'gemini' && /^gemini-2\.5(?:-|$)/.test(String(model.id || ''));
  return `${compactModelName(model.id, model.name, 42)}${free ? ' · Free tier' : paid ? ' · Paid API' : legacy ? ' · Legacy access' : ''}`;
}
function providerLabel() { return `${state.provider} · ${compactModelName(state.model || 'choose a model', '', 28)}`; }
function composerExtras() {
  const editingMessage = state.editingMessageId ? state.messages.find(message => message.id === state.editingMessageId) : null;
  const chips = [
    ...state.attached.map(path => `<span class="ctx-chip" title="${escape(path)}">@ ${escape(path.split('/').pop())}<button type="button" data-unpin="${escape(path)}">×</button></span>`),
    ...state.shellOutputs.map(item => `<span class="ctx-chip" title="Shell output attached">$ ${escape(item.cmd)}<button type="button" data-unpin-shell="${item.id}">×</button></span>`),
    ...state.uploads.map(u => `<span class="ctx-chip" title="${escape(u.name)}">${u.type.startsWith('image/')?'🖼':'📎'} ${escape(u.name)}<button type="button" data-unpin-upload="${u.id}">×</button></span>`)
  ];
  const editBanner = editingMessage ? `<div class="edit-message-banner"><span><b>Editing previous message</b><small>The original stays in chat; sending creates an edited follow-up.</small></span><button type="button" id="cancel-message-edit" title="Cancel editing" aria-label="Cancel editing">×</button></div>` : '';
  return `${editBanner}${state.shellOpen ? `<div class="shell-bar"><span class="shell-prompt">$</span><input id="shell-input" placeholder="Run a command in ${escape(state.projectName)}… e.g. git status --short" autocomplete="off" spellcheck="false" /><button type="button" class="shell-run" id="shell-run" ${state.shellBusy?'disabled':''}>${state.shellBusy?'Running…':'Run'}</button><button type="button" class="icon-btn" id="shell-close" title="Close">×</button></div>` : ''}${chips.length ? `<div class="ctx-chips">${chips.join('')}</div>` : ''}`;
}
function attachModal() {
  const source = (fsMode()==='memory' ? Object.keys(state.files) : state.treePaths).filter(isTextFile);
  const list = source.slice(0, 400).map(path => `<label class="attach-row${state.attached.includes(path)?' checked':''}"><input type="checkbox" data-attach="${escape(path)}" ${state.attached.includes(path)?'checked':''} /><span>${escape(path)}</span></label>`).join('');
  const uploadsList = state.uploads.map(u => `<label class="attach-row checked"><input type="checkbox" data-attach-upload="${u.id}" checked disabled /><span>${u.type.startsWith('image/')?'🖼':'📎'} ${escape(u.name)} (${Math.round(u.data.length*0.75/1024)} KB)</span></label>`).join('');
  return `<div class="modal-backdrop"><section class="modal attach-modal" role="dialog" aria-modal="true"><h2>Images & Files</h2><p>Pick workspace files or upload images/files to send as context.</p><input class="catalog-search" id="attach-search" placeholder="Find files…" autocomplete="off" /><div class="attach-list">${uploadsList ? `${uploadsList}<div class="attach-divider"><span>Uploaded</span></div>` : ''}${list || '<small>No text files in this workspace yet.</small>'}</div><div class="upload-dropzone" id="upload-dropzone"><input type="file" id="file-upload" multiple accept="image/*,.pdf,.txt,.md,.json,.js,.ts,.jsx,.tsx,.py,.rs,.go,.java,.cpp,.c,.h,.css,.html,.svg" style="display:none" /><svg class="upload-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v11m0 0 4-4m-4 4-4-4M5 18v3h14v-3" /></svg><span>Drag & drop images/files here, or click to select</span><small>Supports images, PDF, text files (max 10MB each)</small></div><div class="modal-actions"><button type="button" id="cancel-attach">Cancel</button><button type="button" class="primary" id="apply-attach">Attach ${(state.attached.length + state.uploads.length) ? `(${state.attached.length + state.uploads.length})` : ''}</button></div></section></div>`;
}
async function buildContext(pendingUploads = state.uploads) {
  const parts = [];
  try {
    for (const path of state.attached) {
      if (fsMode()!=='memory') await ensureLoaded(path);
      const content = state.files[path];
      if (content != null) parts.push({ name: path, content: String(content).slice(0, 40000) });
    }
    for (const item of state.shellOutputs) parts.push({ name: `shell output: ${item.cmd}`, content: item.output.slice(0, 40000) });
    // include uploaded images/files
    for (const u of pendingUploads) {
      if (u.type.startsWith('image/')) {
        parts.push({ name: u.name, image: u.data, type: u.type }); // base64 data URL
      } else if (u.type.startsWith('text/') || u.type === 'application/json' || u.type === 'application/pdf') {
        parts.push({ name: u.name, content: u.data, type: u.type });
      }
    }
  } catch {}
  return parts;
}
async function runShellCommand() {
  const input = document.querySelector('#shell-input');
  const command = input?.value.trim();
  if (!command || state.shellBusy) return;
  state.shellBusy = true; app();
  try {
    let output = '';
    if (window.__TAURI_INTERNALS__) { output = await tauriInvoke('run_shell_command', { root: state.dirPath || null, command }); }
    else {
      const response = await fetch('/api/exec', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ root: state.dirPath || undefined, command }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not run the command.');
      output = data.output || '';
      if (data.timedOut) output += `${output ? '\n' : ''}[command timed out after 30s]`;
      else if (data.exitCode) output += `${output ? '\n' : ''}[exit code ${data.exitCode}]`;
    }
    state.shellOutputs = [...state.shellOutputs.slice(-3), { id: Date.now(), cmd: command, output }];
    state.vscodeNote = output.trim() ? `Attached output of "${command}".` : `"${command}" produced no output.`;
  } catch (error) { state.vscodeNote = error.message || String(error); }
  finally { state.shellBusy=false; state.shellOpen=false; app(); }
}
// --- opencode-inspired agent helpers ---
function workspaceRelativePath(value) {
  const raw = String(value || '').trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (!raw || raw.startsWith('/') || /^[A-Za-z]:\//.test(raw) || raw.split('/').some(part => !part || part === '..')) {
    throw new Error('Use a relative path inside the open workspace.');
  }
  return raw;
}
function globToRegExp(pattern) {
  const raw = String(pattern || '*').replace(/\\/g, '/');
  let source = '';
  for (let i = 0; i < raw.length; i++) {
    const char = raw[i];
    if (char === '*') {
      if (raw[i + 1] === '*') {
        i++;
        if (raw[i + 1] === '/') { i++; source += '(?:.*/)?'; }
        else source += '.*';
      } else source += '[^/]*';
    } else if (char === '?') source += '[^/]';
    else source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  if (!raw.includes('/')) source = '(?:.*/)?' + source;
  return new RegExp('^' + source + '$');
}
async function agentGlob(pattern) {
  const paths = fsMode()==='memory' ? Object.keys(state.files) : state.treePaths;
  if (!pattern || pattern === '*') return paths.slice(0, 200);
  const rx = globToRegExp(pattern);
  const matched = paths.filter(p => rx.test(p));
  if (matched.length) return matched.slice(0, 200);
  // fallback: simple substring
  const low = pattern.toLowerCase().replace(/\*/g,'');
  return paths.filter(p => p.toLowerCase().includes(low)).slice(0, 200);
}
async function agentGrep(pattern, include) {
  const paths = fsMode()==='memory' ? Object.keys(state.files) : state.treePaths;
  let rx;
  try { rx = new RegExp(pattern, 'i'); } catch { rx = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); }
  const filter = include ? globToRegExp(include) : null;
  const out = [];
  for (const p of paths.slice(0, 800)) {
    if (filter && !filter.test(p)) continue;
    try {
      if (fsMode()!=='memory') await ensureLoaded(p);
      const content = state.files[p];
      if (content == null) continue;
      const lines = String(content).split('\n');
      for (let i=0;i<lines.length && out.length<200;i++) if (rx.test(lines[i])) out.push(`${p}:${i+1}: ${lines[i].slice(0,200)}`);
    } catch {}
  }
  return out;
}
async function agentRead(filePath) {
  filePath = workspaceRelativePath(filePath);
  const knownPaths = fsMode()==='memory' ? Object.keys(state.files) : state.treePaths;
  if (!knownPaths.includes(filePath)) {
    const avail = knownPaths.slice(0,8).join(', ');
    throw new Error(`File not found: ${filePath}. Available: ${avail || '(no files)'}`);
  }
  if (fsMode()!=='memory') await ensureLoaded(filePath);
  const c = state.files[filePath];
  if (c == null) {
    const avail = knownPaths.slice(0,8).join(', ');
    throw new Error(`File not found: ${filePath}. Available: ${avail || '(no files)'}`);
  }
  const str = String(c);
  if (!str.trim()) return `(empty file: ${filePath} — 0 chars. You should WRITE the full content for this file using the write tool.)`;
  return str.slice(0, 40000);
}
async function agentWrite(filePath, content) {
  filePath = workspaceRelativePath(filePath);
  if (content == null) throw new Error('content required');
  if (fsMode()==='memory') {
    state.files[filePath] = String(content);
  } else {
    await writeFileAt(filePath, String(content));
    state.files[filePath] = String(content);
    if (!state.treePaths.includes(filePath)) { state.treePaths.push(filePath); state.treePaths.sort(); }
    state.dirtyFiles.delete(filePath);
    if (state.active === filePath) { state.dirty = false; }
  }
  app();
  return `Wrote ${filePath} (${String(content).length} chars)`;
}
async function agentEdit(filePath, oldString, newString, replaceAll) {
  filePath = workspaceRelativePath(filePath);
  if (oldString == null || newString == null) throw new Error('filePath, oldString, newString required');
  if (fsMode()!=='memory') await ensureLoaded(filePath);
  let content = state.files[filePath];
  if (content == null) throw new Error(`File not found: ${filePath}`);
  content = String(content);
  if (!content.includes(oldString)) throw new Error(`oldString not found in ${filePath}. Ensure exact match including whitespace.`);
  const next = replaceAll ? content.split(oldString).join(newString) : content.replace(oldString, newString);
  return agentWrite(filePath, next);
}
async function agentBash(command) {
  if (!command || !String(command).trim()) throw new Error('command required');
  const cmd = String(command).trim();
  // block destructive outside project? allow all for now (opencode default allow)
  let output = '';
  if (window.__TAURI_INTERNALS__) {
    output = await tauriInvoke('run_shell_command', { root: state.dirPath || null, command: cmd });
  } else {
    const r = await fetch('/api/exec', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ root: state.dirPath || undefined, command: cmd }) });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'Command failed');
    output = d.output || '';
    if (d.timedOut) output += `${output ? '\n' : ''}[command timed out after 30s]`;
    else if (d.exitCode) output += `${output ? '\n' : ''}[exit code ${d.exitCode}]`;
  }
  return output.slice(0, 6000) || '(no output)';
}
function commandNeedsApproval(command) {
  return /(^|[;&|]\s*)(sudo\b|rm\s+-[^\n]*r[^\n]*f|git\s+(?:reset\s+--hard|clean\s+-[^\n]*f)|(?:shutdown|reboot|halt)\b|diskutil\s+erase|mkfs\b|format\s+[A-Za-z]:|(?:del|rd)\s+\/s\s+\/q)|(?:curl|wget)[^\n|]*\|\s*(?:sh|bash)\b/i.test(String(command || ''));
}
async function executeTool(name, args, audit = null) {
  const knownPaths = fsMode()==='memory' ? Object.keys(state.files) : state.treePaths;
  const blocked = guardToolCall(audit, name, args, knownPaths);
  if (blocked) return blocked;
  let output;
  switch (name) {
    case 'read': output = await agentRead(args.filePath); break;
    case 'write': output = await agentWrite(args.filePath, args.content); break;
    case 'edit': output = await agentEdit(args.filePath, args.oldString, args.newString, args.replaceAll); break;
    case 'bash': {
      if (commandNeedsApproval(args.command) && !window.confirm(`The coding agent wants to run a potentially destructive command:\n\n${args.command}\n\nRun it?`)) return 'Blocked: the user did not approve this command.';
      output = await agentBash(args.command); break;
    }
    case 'glob': { const m = await agentGlob(args.pattern); output = m.length ? m.join('\n') : 'No files matched.'; break; }
    case 'grep': { const m = await agentGrep(args.pattern, args.include); output = m.length ? m.join('\n') : 'No matches found.'; break; }
    case 'todowrite': { state.todos = Array.isArray(args.todos) ? args.todos : []; app(); output = `Todos updated: ${state.todos.length} items`; break; }
    default: throw new Error(`Unknown tool: ${name}`);
  }
  recordToolResult(audit, name, args);
  return output;
}
function handleFiles(files) {
  const arr = Array.from(files).filter(f => f && f.size > 0 && f.size <= 10 * 1024 * 1024);
  arr.forEach(f => {
    const reader = new FileReader();
    reader.onload = () => {
      state.uploads.push({ id: 'up_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6), name: f.name, type: f.type, data: reader.result, preview: f.type.startsWith('image/') ? reader.result : null });
      app();
    };
    if (f.type.startsWith('image/') || f.type === 'application/pdf') reader.readAsDataURL(f);
    else reader.readAsText(f);
  });
}
function openComputerFilePicker() {
  let input = document.querySelector('#computer-file-picker');
  if (!input) {
    input = document.createElement('input');
    input.id = 'computer-file-picker';
    input.type = 'file';
    input.multiple = true;
    input.hidden = true;
    input.accept = 'image/*,.pdf,.txt,.md,.json,.js,.ts,.jsx,.tsx,.py,.rs,.go,.java,.cpp,.c,.h,.css,.html,.svg';
    input.addEventListener('change', event => {
      handleFiles(event.currentTarget.files);
      event.currentTarget.value = '';
    });
    document.body.append(input);
  }
  input.click();
}
async function copyChatMessage(id) {
  const message = state.messages.find(item => item.id === id);
  const text = String(message?.content || '');
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.append(textarea);
    textarea.select();
    document.execCommand('copy');
    textarea.remove();
  }
  state.copiedMessageId = id;
  app();
  setTimeout(() => { if (state.copiedMessageId === id) { state.copiedMessageId = ''; app(); } }, 1400);
}
function editChatMessage(id) {
  if (state.sending) return;
  const message = state.messages.find(item => item.id === id && item.role === 'user');
  if (!message) return;
  state.editingMessageId = id;
  state.draftPrompt = String(message.content || '');
  state.plusOpen = false;
  app();
  requestAnimationFrame(() => {
    const input = document.querySelector('#prompt');
    input?.focus();
    if (input) input.setSelectionRange(input.value.length, input.value.length);
  });
}
function cancelMessageEdit() {
  state.editingMessageId = '';
  state.draftPrompt = '';
  app();
  requestAnimationFrame(() => document.querySelector('#prompt')?.focus());
}
function isTauriEnv() { return !!window.__TAURI_INTERNALS__; }
async function openExternalUrl(value) {
  const url = new URL(String(value || ''), location.href);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only http and https links can be opened.');
  if (isTauriEnv()) return tauriInvoke('open_external_url', { url: url.href });
  const opened = window.open(url.href, '_blank', 'noopener');
  if (!opened) throw new Error('Your browser blocked the new tab. Allow pop-ups for CodePlus and try again.');
}
function bindExternalLinks(root = document) {
  if (!isTauriEnv()) return;
  root.querySelectorAll('a[href^="http://"], a[href^="https://"]').forEach(anchor => {
    listen(anchor, 'click', event => {
      event.preventDefault();
      openExternalUrl(anchor.href).catch(error => {
        state.vscodeNote = `Could not open link: ${error.message || String(error)}`;
        app();
      });
    });
  });
}
function isLocalHost() { return location.hostname === 'localhost' || location.hostname === '127.0.0.1' || location.hostname.endsWith('.localhost'); }
const LANDING_DOWNLOADS = {
  macos: { local: 'https://github.com/naylinhtunit/CodePlus-Releases/releases/latest/download/CodePlus-macOS-arm64.dmg', asset: 'CodePlus-macOS-arm64.dmg' },
  windows: { local: 'https://github.com/naylinhtunit/CodePlus-Releases/releases/latest/download/CodePlus-windows-x64-setup.exe', asset: 'CodePlus-windows-x64-setup.exe' }
};
const LANDING_SHOWCASE = [
  { src: '/assets/codeplus-showcase-workspace.webp', title: 'One focused coding workspace', description: 'Explore files, edit code, inspect the live preview, and work with your AI agent without changing tools.', alt: 'CodePlus workspace with Explorer, page.tsx editor, live preview, and Coding Agent' },
  { src: '/assets/codeplus-showcase-provider.webp', title: 'Bring your own AI stack', description: 'Run coding models locally with Ollama or connect a cloud provider with settings that stay on your device.', alt: 'CodePlus AI provider settings showing a local Ollama model' },
  { src: '/assets/codeplus-showcase-providers.webp', title: 'Choose from 12 AI providers', description: 'Switch between local Ollama and cloud providers including OpenAI, Anthropic, Gemini, Groq, and OpenRouter.', alt: 'CodePlus provider menu showing local and cloud AI providers' },
  { src: '/assets/codeplus-showcase-catalog.webp', title: 'Manage local models in place', description: 'Browse, search, download, and remove Ollama models directly from the same workspace.', alt: 'CodePlus Ollama model catalog with installed and downloadable models' }
];
let landingDownloadUrls = Object.fromEntries(Object.entries(LANDING_DOWNLOADS).map(([platform, item]) => [platform, item.local]));
let landingDownloadCounts = { macos: null, windows: null };
let landingDownloadsChecked = false;
let landingShowcaseIndex = 0;
let landingShowcaseTimer = 0;
let landingShowcaseHoverPaused = false;
let landingShowcaseFocusPaused = false;
let landingShowcaseUserPaused = false;
const landingShowcaseReducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
function landingShowcaseIsPaused() { return landingShowcaseHoverPaused || landingShowcaseFocusPaused || landingShowcaseUserPaused || landingShowcaseReducedMotion(); }
function restartLandingShowcaseProgress() {
  const bar = document.querySelector('.landing-showcase-progress span');
  if (!bar) return;
  bar.style.animation = 'none';
  void bar.offsetWidth;
  bar.style.animation = '';
}
function scheduleLandingShowcase() {
  window.clearTimeout(landingShowcaseTimer);
  const root = document.querySelector('.landing-showcase');
  if (!root) return;
  const paused = landingShowcaseIsPaused();
  root.classList.toggle('is-paused', paused);
  const pauseButton = root.querySelector('#showcase-pause');
  if (pauseButton) {
    pauseButton.setAttribute('aria-label', landingShowcaseUserPaused ? 'Play product tour' : 'Pause product tour');
    pauseButton.innerHTML = landingShowcaseUserPaused ? '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m7 5 8 5-8 5Z"/></svg>' : '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M7 5v10M13 5v10"/></svg>';
  }
  if (paused) return;
  restartLandingShowcaseProgress();
  landingShowcaseTimer = window.setTimeout(() => setLandingShowcaseSlide(landingShowcaseIndex + 1), 6500);
}
function setLandingShowcaseSlide(index) {
  const total = LANDING_SHOWCASE.length;
  landingShowcaseIndex = (index + total) % total;
  document.querySelectorAll('[data-showcase-slide]').forEach((slide, slideIndex) => {
    const active = slideIndex === landingShowcaseIndex;
    slide.classList.toggle('active', active);
    slide.setAttribute('aria-hidden', String(!active));
  });
  document.querySelectorAll('[data-showcase-copy]').forEach((copy, copyIndex) => copy.classList.toggle('active', copyIndex === landingShowcaseIndex));
  document.querySelectorAll('[data-showcase-dot]').forEach((dot, dotIndex) => {
    const active = dotIndex === landingShowcaseIndex;
    dot.classList.toggle('active', active);
    dot.setAttribute('aria-current', active ? 'true' : 'false');
  });
  const count = document.querySelector('#showcase-count');
  if (count) count.textContent = `${String(landingShowcaseIndex + 1).padStart(2, '0')} / ${String(total).padStart(2, '0')}`;
  scheduleLandingShowcase();
}
async function resolveLandingDownloadUrls() {
  if (landingDownloadsChecked || isTauriEnv()) return;
  landingDownloadsChecked = true;
  try {
    const summaryResponse = await fetch('/api/download-counts', { headers: { Accept: 'application/json' } });
    if (summaryResponse.ok) {
      const summary = await summaryResponse.json();
      for (const platform of Object.keys(LANDING_DOWNLOADS)) {
        if (summary.urls?.[platform]) landingDownloadUrls[platform] = summary.urls[platform];
        landingDownloadCounts[platform] = Number.isFinite(summary.counts?.[platform]) ? summary.counts[platform] : null;
      }
      app();
      return;
    }
    const githubResponse = await fetch('https://api.github.com/repos/naylinhtunit/CodePlus-Releases/releases?per_page=100', {
      headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }
    });
    if (!githubResponse.ok) return;
    const releases = (await githubResponse.json()).filter(release => !release.draft);
    const matchesPlatform = (platform, asset) => {
      const name = String(asset?.name || '').toLowerCase();
      if (name === LANDING_DOWNLOADS[platform].asset.toLowerCase()) return true;
      if (platform === 'macos') return name.includes('codeplus') && name.endsWith('.dmg') && /(macos|aarch64|arm64)/.test(name);
      return name.includes('codeplus') && name.endsWith('.exe') && /(windows|win32|x64|setup)/.test(name);
    };
    const nextCounts = { macos: 0, windows: 0 };
    const found = { macos: false, windows: false };
    for (const [platform, item] of Object.entries(LANDING_DOWNLOADS)) {
      for (const release of releases) {
        for (const asset of release.assets || []) {
          if (!matchesPlatform(platform, asset)) continue;
          found[platform] = true;
          nextCounts[platform] += Number(asset.download_count) || 0;
          if (landingDownloadUrls[platform] === item.local && asset.browser_download_url) {
            landingDownloadUrls[platform] = asset.browser_download_url;
          }
        }
      }
    }
    landingDownloadCounts = Object.fromEntries(Object.keys(nextCounts).map(platform => [platform, found[platform] ? nextCounts[platform] : null]));
    app();
  } catch {}
}
function formatDownloadCount(count) {
  return Number.isFinite(count) ? `${new Intl.NumberFormat().format(count)} downloads` : 'GitHub count unavailable';
}
function landing(hideWeb, vercelNotice) {
  const dl = state.downloadOpen ? `<div class="download-menu" role="menu"><a href="${escape(landingDownloadUrls.macos)}" role="menuitem"><span class="download-option-head"><strong>macOS</strong><b>${escape(formatDownloadCount(landingDownloadCounts.macos))}</b></span><small>Apple Silicon · .dmg</small></a><a href="${escape(landingDownloadUrls.windows)}" role="menuitem"><span class="download-option-head"><strong>Windows</strong><b>${escape(formatDownloadCount(landingDownloadCounts.windows))}</b></span><small>x64 · Setup.exe</small></a></div>` : '';
  const statValue = count => Number.isFinite(count) ? new Intl.NumberFormat().format(count) : '—';
  const downloadStats = Object.values(landingDownloadCounts).some(Number.isFinite) ? `<div class="landing-download-stats" aria-label="Desktop app download totals"><span><strong>${escape(statValue(landingDownloadCounts.macos))}</strong> macOS downloads</span><i aria-hidden="true"></i><span><strong>${escape(statValue(landingDownloadCounts.windows))}</strong> Windows downloads</span></div>` : '';
  const showcaseSlides = LANDING_SHOWCASE.map((slide, index) => `<figure class="landing-showcase-slide ${index===landingShowcaseIndex?'active':''}" data-showcase-slide aria-roledescription="slide" aria-label="${index + 1} of ${LANDING_SHOWCASE.length}" aria-hidden="${index!==landingShowcaseIndex}"><img src="${escape(slide.src)}" alt="${escape(slide.alt)}" ${index===0?'fetchpriority="high"':'loading="lazy"'} decoding="async" /></figure>`).join('');
  const showcaseCopy = LANDING_SHOWCASE.map((slide, index) => `<article class="landing-showcase-copy ${index===landingShowcaseIndex?'active':''}" data-showcase-copy><h2>${escape(slide.title)}</h2><p>${escape(slide.description)}</p></article>`).join('');
  const showcaseDots = LANDING_SHOWCASE.map((slide, index) => `<button type="button" class="landing-showcase-dot ${index===landingShowcaseIndex?'active':''}" data-showcase-dot="${index}" aria-label="Show ${escape(slide.title)}" aria-current="${index===landingShowcaseIndex}"><span></span></button>`).join('');
  return el`<div class="landing">
    <header class="landing-nav">
      <div class="brand"><img class="brand-logo" src="/assets/codeplus-logo.png" alt="CodePlus" />CodePlus</div>
      <div class="download-wrap"><button class="download" id="landing-downloads" aria-haspopup="menu" aria-expanded="${state.downloadOpen}">Download <svg class="download-chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg></button>${dl}</div>
    </header>
    ${vercelNotice ? `<div class="landing-notice">Web app is only available when running CodePlus locally. Download the desktop app to get started.</div>` : ``}
    <section class="landing-hero">
      <span class="landing-eyebrow">LOCAL-FIRST · MULTI-MODEL · BROWSER + DESKTOP</span>
      <h1>Build faster with your own AI stack.</h1>
      <p>One focused workspace for browser and desktop. File explorer, code editor, live preview, and 12 AI providers — Ollama, OpenAI, Anthropic, Gemini, Groq, DeepSeek and more. Files stay on your disk.</p>
      <div class="landing-cta">
        ${hideWeb ? `` : `<a class="landing-primary" id="open-web-app" href="/app">Open Web App →</a>`}
      </div>
      <div class="landing-badges"><span>12 providers</span><span>Local-first</span><span>Tauri desktop</span><span>Live preview</span></div>
      ${downloadStats}
    </section>
    <section class="landing-showcase" aria-label="CodePlus product tour" aria-roledescription="carousel" tabindex="0">
      <div class="landing-showcase-shell">
        <div class="landing-showcase-stage">${showcaseSlides}<div class="landing-showcase-tag"><span></span>Product walkthrough</div></div>
        <div class="landing-showcase-rail">
          <div class="landing-showcase-count" id="showcase-count">${String(landingShowcaseIndex + 1).padStart(2, '0')} / ${String(LANDING_SHOWCASE.length).padStart(2, '0')}</div>
          <div class="landing-showcase-copy-stack">${showcaseCopy}</div>
          <div class="landing-showcase-controls"><button type="button" class="landing-showcase-arrow" id="showcase-prev" aria-label="Previous screenshot"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m12.5 5-5 5 5 5"/></svg></button><div class="landing-showcase-dots">${showcaseDots}</div><button type="button" class="landing-showcase-pause" id="showcase-pause" aria-label="Pause product tour"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M7 5v10M13 5v10"/></svg></button><button type="button" class="landing-showcase-arrow" id="showcase-next" aria-label="Next screenshot"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m7.5 5 5 5-5 5"/></svg></button></div>
        </div>
        <div class="landing-showcase-progress"><span></span></div>
      </div>
    </section>
    <section class="landing-features">
      <article><h3>File explorer &amp; editor</h3><p>Direct disk access via File System API / native dialog. Lazy-loaded tree, write-through saves, syntax highlight, and 60KB+ bailout so large files never freeze.</p></article>
      <article><h3>Live preview</h3><p>Auto-detects <code>package.json</code> dev script, finds the real port (<code>-p</code>/<code>--port</code> or Vite 5173), waits until ready, and shows your app in an iframe. Start/stop from the preview bar.</p></article>
      <article><h3>12 AI providers</h3><p>Ollama catalog (29 models), plus OpenAI, Anthropic, Gemini, Groq, DeepSeek, Mistral, xAI, OpenRouter, Together, Fireworks, and Cerebras.</p></article>
      <article><h3>Coding agent</h3><p>Give it a task in plain language. The agent inspects the workspace, reads and edits files, runs checks, and keeps working through tool results until the change is complete.</p></article>
      <article><h3>Desktop parity</h3><p>Same UI on web, macOS (DMG) and Windows (NSIS). Tauri backend mirrors the Node server: workspace I/O, dev server, and Ollama.</p></article>
      <article><h3>Private by design</h3><p>No upload — you pick a folder, CodePlus edits in place. Vercel hosts only this landing page; your code never leaves your machine.</p></article>
    </section>
    <section class="landing-how">
      <h2>How it works</h2>
      <ol><li><strong>Download</strong> the desktop app or click <em>Open Web App</em> locally.</li><li><strong>Open a folder</strong> from disk.</li><li><strong>Pick a provider</strong> — local Ollama or any cloud key.</li><li><strong>Build</strong> — preview updates live, AI sees your files.</li></ol>
    </section>
    <section class="landing-mac-help" aria-labelledby="mac-first-open-title">
      <div class="landing-mac-help-head"><span>macOS first launch</span><h2 id="mac-first-open-title">Seeing “CodePlus Not Opened”?</h2><p>The current Mac build is signed but is waiting for Apple notarization. If macOS blocks it, use either option below after downloading CodePlus from this page.</p></div>
      <div class="landing-mac-help-options">
        <article><b>Recommended</b><strong>Open Anyway</strong><p>Try opening CodePlus once. Then open <em>System Settings → Privacy &amp; Security</em>, scroll down, click <em>Open Anyway</em>, and confirm.</p></article>
        <article><b>Terminal fallback</b><strong>Allow CodePlus only</strong><p>Drag CodePlus into Applications, open Terminal, then run:</p><div class="landing-command"><code>xattr -dr com.apple.quarantine "/Applications/CodePlus.app" &amp;&amp; open "/Applications/CodePlus.app"</code><button type="button" id="copy-mac-command" aria-label="Copy macOS first-launch command">Copy</button></div></article>
      </div>
      <small>Only run this for CodePlus downloaded from this page. It removes quarantine from CodePlus only and does not disable Gatekeeper system-wide.</small>
    </section>
    <footer class="landing-foot"><span>© CodePlus — built local-first</span></footer>
  </div>`;
}
function bindLanding() {
  resolveLandingDownloadUrls();
  bindExternalLinks();
  document.querySelector('#landing-downloads')?.addEventListener('click', () => { state.downloadOpen = !state.downloadOpen; app(); });
  document.querySelector('#open-web-app')?.addEventListener('click', e => { e.preventDefault(); history.pushState(null, '', '/app'); app(); });
  document.querySelector('#copy-mac-command')?.addEventListener('click', async event => {
    const button = event.currentTarget;
    const command = 'xattr -dr com.apple.quarantine "/Applications/CodePlus.app" && open "/Applications/CodePlus.app"';
    try { await navigator.clipboard.writeText(command); button.textContent = 'Copied'; }
    catch { button.textContent = 'Select manually'; }
  });
  const showcase = document.querySelector('.landing-showcase');
  document.querySelector('#showcase-prev')?.addEventListener('click', () => setLandingShowcaseSlide(landingShowcaseIndex - 1));
  document.querySelector('#showcase-next')?.addEventListener('click', () => setLandingShowcaseSlide(landingShowcaseIndex + 1));
  document.querySelector('#showcase-pause')?.addEventListener('click', () => { landingShowcaseUserPaused = !landingShowcaseUserPaused; scheduleLandingShowcase(); });
  document.querySelectorAll('[data-showcase-dot]').forEach(dot => dot.addEventListener('click', () => setLandingShowcaseSlide(Number(dot.dataset.showcaseDot))));
  showcase?.addEventListener('mouseenter', () => { landingShowcaseHoverPaused=true;scheduleLandingShowcase(); });
  showcase?.addEventListener('mouseleave', () => { landingShowcaseHoverPaused=false;scheduleLandingShowcase(); });
  showcase?.addEventListener('focusin', () => { landingShowcaseFocusPaused=true;scheduleLandingShowcase(); });
  showcase?.addEventListener('focusout', event => { if (!showcase.contains(event.relatedTarget)) { landingShowcaseFocusPaused=false;scheduleLandingShowcase(); } });
  showcase?.addEventListener('keydown', event => { if (event.key==='ArrowLeft') { event.preventDefault();setLandingShowcaseSlide(landingShowcaseIndex - 1); } if (event.key==='ArrowRight') { event.preventDefault();setLandingShowcaseSlide(landingShowcaseIndex + 1); } });
  scheduleLandingShowcase();
  document.addEventListener('click', function onDoc(e) {
    if (!e.target.closest('.download-wrap')) { if (state.downloadOpen) { state.downloadOpen = false; app(); } document.removeEventListener('click', onDoc); }
  });
}
function app(forcePreviewReload = false) {
  const previousChat = document.querySelector('#chat');
  const previousChatContent = previousChat?.innerHTML;
  const previousChatWasAtBottom = !previousChat || previousChat.scrollHeight - previousChat.scrollTop - previousChat.clientHeight <= 48;
  const prevCatalog = document.querySelector('.model-catalog');
  const prevScroll = prevCatalog ? prevCatalog.scrollTop : 0;
  const prevSearchVal = document.querySelector('#catalog-search')?.value ?? null;
  const prevSearchFocused = document.activeElement?.id === 'catalog-search';
  const isTauri = isTauriEnv();
  const path = location.pathname;
  const local = isLocalHost();
  if (!isTauri) {
    if (path === '/' || path === '/index.html') {
      const hideWeb = !local;
      document.body.style.minWidth = '0';
      document.querySelector('#app').innerHTML = landing(hideWeb, false);
      bindLanding();
      return;
    }
    if (path === '/app' || path.startsWith('/app/')) {
      if (!local) {
        document.body.style.minWidth = '0';
        document.querySelector('#app').innerHTML = landing(true, true);
        bindLanding();
        return;
      }
    }
  }
  document.body.style.minWidth = '';
  const activeName = state.active.split('/').at(-1);
  const previewPanel = `<div class="preview studio-preview" data-panel="preview">${previewAddress()}<div class="preview-body">${preview()}</div></div>`;
  const explorerToggle = `<button class="icon-btn" id="toggle-files" title="${state.filesHidden ? 'Show' : 'Hide'} Explorer">☰</button>`;
  // Keep the preview's entire ancestor chain connected across file, layout,
  // and VS Code view changes. CSS controls which editor occupies the grid.
  const workspace = `<section class="work" data-panel="work"><div class="tabs" data-panel="tabs"><div class="tab ${state.editorClosed ? 'tab-empty' : ''}">${state.editorClosed ? 'Preview' : `⌘ ${escape(activeName)}<button class="tab-close" id="close-file" type="button" title="Close ${escape(activeName)}">×</button>`}</div><div class="tab-actions">${explorerToggle}${state.editorClosed ? '' : `<button class="icon-btn" id="format" title="Format active file">⌁</button><button class="icon-btn" id="toggle-preview" title="${state.previewHidden?'Show':'Hide'} preview">◱</button>`}</div></div><div class="editor-grid ${state.editorClosed ? 'editor-closed' : state.previewHidden ? 'preview-hidden' : ''}" data-panel="editor-grid"><div class="editor" data-panel="editor"><div class="pane-title"><span>${escape(state.active)}</span><span class="language">${state.active.endsWith('.css')?'CSS':state.active.endsWith('.md')?'Markdown':'TypeScript React'}</span></div><div class="code-shell"><div class="line-numbers" id="line-numbers" aria-hidden="true">${lineNumbers(state.files[state.active] ?? '')}</div><div class="code-layer"><pre class="code-highlight" id="code-highlight" aria-hidden="true">${highlightCode(state.files[state.active] ?? '')}</pre><textarea class="code" id="code" spellcheck="false" wrap="off">${escape(state.files[state.active] ?? '')}</textarea></div></div></div><section class="vscode-panel" data-panel="vscode">${state.vscodeUrl ? `<div class="vscode-panel-bar"><strong>⌘ VS Code · CodePlus</strong><span>Local workspace</span><button id="close-vscode">Return to CodePlus editor</button></div><iframe title="VS Code workspace" src="${escape(state.vscodeUrl)}"></iframe>` : ''}</section>${previewPanel}</div></section>`;
  const appRoot = document.querySelector('#app');
  const workspaceMarkup = el`<main class="shell ${state.vscodeView ? 'vscode-mode' : ''} ${state.filesHidden ? 'files-hidden' : ''}">
    <header class="topbar"><div class="brand"><img class="brand-logo" src="/assets/codeplus-logo.png" alt="CodePlus" />CodePlus</div><button class="crumb workspace-trigger" id="workspaces">Workspaces /</button><span class="project">${escape(state.projectName)}</span>${updateButton()}<button class="vscode" id="open-vscode" ${state.vscodeView ? 'disabled' : ''}>${state.vscodeView ? '⌘ VS Code active' : '⌘ VS Code workspace'}</button></header>
    <aside class="files"><div class="side-heading"><span>EXPLORER</span><button class="small-btn" id="new-file" title="New file">＋</button></div><div class="tree">${fileTree()}</div><div class="workspace-card"><strong>${fsMode()==='memory' ? 'Local-first project' : escape(state.projectName)}</strong><span>${state.pendingHandle ? `${escape(state.pendingName)} needs reconnect after refresh.` : fsMode()==='memory' ? 'Files are kept in this browser session.' : `Editing directly on disk — ${state.treePaths.length} files. Saves write straight to the folder.`}</span>${state.pendingHandle ? '<button id="reconnect-ws">Reconnect folder</button>' : ''}<button id="export-project">Export project JSON</button></div></aside>
    ${workspace}
    <aside class="assistant"><div class="ai-head"><strong>Coding Agent</strong><span>Workspace tools enabled</span><button class="icon-btn gear" id="settings" title="Model settings">⚙</button></div><div class="chat" id="chat">${messages()}</div><form class="composer" id="composer">${composerExtras()}<textarea id="prompt" placeholder="Ask ${escape(compactModelName(state.model || 'a model', '', 32))} to build, edit, test, or debug your code…" ${state.sending ? 'disabled' : ''}>${escape(state.draftPrompt || '')}</textarea><div class="composer-foot"><div class="composer-tools">${state.plusOpen ? `<div class="plus-menu" role="menu"><button type="button" data-plus-action="files">⬆ <span>Files</span><small>Choose from My Computer</small></button><button type="button" data-plus-action="shell">$ <span>Shell Output</span><small>Run and attach a command result</small></button></div>` : ''}<button type="button" class="plus-btn" id="plus-btn" title="Attach optional context" aria-haspopup="menu" aria-expanded="${state.plusOpen}">＋</button><button type="button" class="model-chip" id="model-chip" title="${escape(`${state.provider}: ${state.model || 'Choose a model'}`)}"><span class="dot"></span><span>${escape(providerLabel())}</span></button></div>${state.sending ? '<button class="send stop" id="stop" type="button" title="Stop response" aria-label="Stop response"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="8" height="8" rx="1" /></svg></button>' : '<button class="send" id="send" type="submit" title="Send message" aria-label="Send message"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5m0 0-6 6m6-6 6 6" /></svg></button>'}</div></form></aside>
    <footer class="status"><span>◉ <span class="branch">main</span></span><span>${fsMode()==='memory' ? Object.keys(state.files).length : state.treePaths.length} files</span><span>${state.dirtyFiles.size ? `● ${state.dirtyFiles.size} unsaved — ⌘/Ctrl+S to save` : '✓ saved locally'}</span><span class="live">● Local workspace</span></footer>
  </main>${state.settingsOpen ? modal() : ''}${state.modelPickerOpen ? modelPickerModal() : ''}${state.attachPickerOpen ? attachModal() : ''}${state.vscodeConsent ? vscodeConsentModal() : ''}${state.workspacesOpen ? workspaceModal() : ''}${state.vscodeNote ? `<div class="toast ${state.vscodeNote.startsWith('Could') || state.vscodeNote.startsWith('Enter a valid') || state.vscodeNote.startsWith('Update failed') ? '' : 'success'}">${escape(state.vscodeNote)}</div>` : ''}`;
  renderWorkspace(appRoot, workspaceMarkup, { reloadPreview: forcePreviewReload });
  // Keep the syntax overlay aligned when another panel updates mid-edit.
  const code = document.querySelector('#code');
  document.querySelector('#line-numbers').scrollTop = code.scrollTop;
  document.querySelector('#code-highlight').style.transform = `translate(${-code.scrollLeft}px, ${-code.scrollTop}px)`;
  armNoteTimer();
  bind();
  const newCatalog = document.querySelector('.model-catalog');
  if (newCatalog && prevScroll) newCatalog.scrollTop = prevScroll;
  if (prevSearchVal !== null) {
    const newSearch = document.querySelector('#catalog-search');
    if (newSearch && newSearch.value !== prevSearchVal) newSearch.value = prevSearchVal;
    if (prevSearchFocused) newSearch?.focus();
  }
  const nextChat = document.querySelector('#chat');
  const chatChanged = previousChatContent !== nextChat?.innerHTML;
  const renderedChatScrollTop = nextChat?.scrollTop;
  requestAnimationFrame(() => {
    if (!nextChat?.isConnected) return;
    // A delayed WebView animation frame must not override a newer user scroll.
    if (chatChanged && previousChatWasAtBottom && nextChat.scrollTop === renderedChatScrollTop) nextChat.scrollTop = nextChat.scrollHeight;
  });
}
let noteTimer = null, lastNote = '';
function armNoteTimer() {
  if (state.vscodeNote && state.vscodeNote !== lastNote) {
    lastNote = state.vscodeNote;
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => { state.vscodeNote=''; lastNote=''; noteTimer=null; app(); }, 3000);
  } else if (!state.vscodeNote && noteTimer) { clearTimeout(noteTimer); noteTimer=null; lastNote=''; }
}
function compareVersions(left, right) {
  const parts = value => String(value || '').replace(/^v/, '').split('-')[0].split('.').map(part => Number.parseInt(part, 10) || 0);
  const a = parts(left), b = parts(right);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0) ? 1 : -1;
  }
  return 0;
}
function updateButton() {
  if (!window.__TAURI_INTERNALS__ || (!state.updateAvailable && !state.updateBusy)) return '';
  const progress = state.updateBusy && state.updateProgress > 0 && state.updateProgress < 100 ? `<span>${state.updateProgress}%</span>` : '';
  const title = state.updateBusy
    ? state.updateStage === 'restarting' ? 'Restarting CodePlus…' : state.updateStage === 'installing' ? 'Installing update…' : `Downloading CodePlus ${state.latestVersion || 'update'}${state.updateProgress ? ` · ${state.updateProgress}%` : ''}`
    : `Download and install CodePlus ${state.latestVersion}`;
  return `<button id="update-btn" class="update-btn ${state.updateBusy ? 'busy' : ''}" type="button" title="${escape(title)}" aria-label="${escape(title)}" ${state.updateBusy ? 'disabled' : ''}>
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v11m0 0 4-4m-4 4-4-4M5 18v3h14v-3" /></svg>${progress}<i aria-hidden="true"></i>
  </button>`;
}
async function checkForUpdates() {
  if (!window.__TAURI_INTERNALS__ || state.updateBusy || state.updateChecking) return;
  state.updateChecking = true;
  try {
    const currentVersion = await tauriInvoke('app_version');
    localStorage.setItem('codeplus-app-version', currentVersion);
    try {
      const update = await tauriInvoke('check_app_update');
      state.updateAvailable = Boolean(update?.version);
      state.latestVersion = update?.version || '';
      state.updateStage = 'idle';
      app();
      return;
    } catch (error) {
      console.warn('Signed updater check failed; checking the public release version.', error);
    }
    const response = await fetch('https://api.github.com/repos/naylinhtunit/CodePlus-Releases/releases/latest', { headers: { Accept: 'application/vnd.github+json' } });
    if (!response.ok) return;
    const release = await response.json();
    const latest = String(release.tag_name || '').replace(/^v/, '');
    state.updateAvailable = compareVersions(latest, currentVersion) > 0;
    state.latestVersion = state.updateAvailable ? latest : '';
    state.updateStage = 'manual';
    app();
  } catch (error) {
    console.warn('Could not check for CodePlus updates.', error);
  } finally {
    state.updateChecking = false;
  }
}
async function doUpdate() {
  if (!window.__TAURI_INTERNALS__ || state.updateBusy) return;
  if (state.updateStage === 'manual') {
    try { await openExternalUrl('https://github.com/naylinhtunit/CodePlus-Releases/releases/latest'); }
    catch (error) { state.vscodeNote = `Update failed: ${error?.message || String(error)}`; app(); }
    return;
  }
  state.updateBusy = true;
  state.updateStage = 'checking';
  state.updateProgress = 0;
  app();
  let unlisten = () => {};
  try {
    unlisten = await tauriListen('app-update-progress', event => {
      const data = event.payload || {};
      state.updateStage = data.stage || state.updateStage;
      const total = Number(data.total) || 0;
      const downloaded = Number(data.downloaded) || 0;
      state.updateProgress = total > 0 ? Math.min(99, Math.round(downloaded / total * 100)) : state.updateProgress;
      app();
    });
    await tauriInvoke('install_app_update');
  } catch (error) {
    state.updateStage = 'error';
    state.vscodeNote = `Update failed: ${error?.message || String(error)}`;
  } finally {
    unlisten();
    if (state.updateStage !== 'restarting') {
      state.updateBusy = false;
      state.updateProgress = 0;
      app();
    }
  }
}
function localModelField() {
  const installed = new Set(state.localModels.map(item => item.name));
  const icon = type => type === 'download'
    ? `<svg class="model-action-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v11m0 0 4-4m-4 4-4-4M5 18v3h14v-3" /></svg>`
    : `<svg class="model-action-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16m-10 4v6m4-6v6M9 7l1-3h4l1 3m-9 0 1 14h10l1-14" /></svg>`;
  const picker = state.localModels.length
    ? `<div class="installed-model-row"><select id="model">${state.localModels.map(item => `<option value="${escape(item.name)}" ${item.name===state.model?'selected':''}>${escape(compactModelName(item.name, '', 42))}</option>`).join('')}</select><button type="button" class="browse-models" id="browse-local-models">Browse models</button></div><small>Models are detected automatically from Ollama.</small>`
    : `<button type="button" class="empty-local-models" id="browse-local-models" ${state.localModelsLoading?'disabled':''}><span>${state.localModelsLoading ? '◌' : '＋'}</span>${state.localModelsLoading ? 'Checking installed models…' : 'No local models installed yet'}<b>Browse models ›</b></button><small class="${state.localModelsError?'error-text':''}">${state.localModelsError || 'Choose a model from the Ollama library and download it to this Mac.'}</small>`;
  const sortedCatalog = [...localModelCatalog].sort((a,b) => Number(installed.has(b.name)) - Number(installed.has(a.name)));
  const cards = sortedCatalog.map(model => {
    const isInstalled = installed.has(model.name);
    const pullPercent = state.pullProgress[model.name];
    const isPulling = Number.isFinite(pullPercent);
    const isSelected = state.model === model.name;
    const isRemoving = state.removingModel === model.name;
    const action = isInstalled
      ? `<button type="button" class="model-card-action remove" data-delete-model="${escape(model.name)}" ${isRemoving?'disabled':''} title="Delete ${escape(model.title)}" aria-label="Delete ${escape(model.title)}">${isRemoving ? '<span class="loader"></span>' : icon('delete')}</button>`
      : `<button type="button" class="model-card-action download ${isPulling?'progress':''}" data-pull-model="${escape(model.name)}" ${isPulling?'disabled':''} title="Download ${escape(model.title)}" aria-label="Download ${escape(model.title)}">${isPulling ? `${pullPercent}%` : icon('download')}</button>`;
    return `<article class="model-card ${isSelected?'active':''}"><div class="model-card-copy"><div><strong>${escape(model.title)}</strong><span>${escape(model.size)}</span></div><p>${escape(model.description)}</p>${isPulling ? `<div class="model-progress" aria-label="Downloading ${pullPercent}%"><span style="width:${pullPercent}%"></span></div>` : ''}</div>${action}</article>`;
  }).join('');
  const catalog = state.catalogOpen ? `<div class="catalog-browser"><div class="catalog-heading"><span>Choose a model</span><span>Ollama library</span></div><input class="catalog-search" id="catalog-search" placeholder="Find model…" autocomplete="off" /><div class="model-catalog">${cards}</div></div>` : '';
  const confirmation = state.modelDeleteConfirm ? `<div class="model-delete-confirm" role="alert"><strong>Delete ${escape(state.modelDeleteConfirm.model)}?</strong><p>This removes the downloaded model from Ollama. You can download it again later.</p><button type="button" id="cancel-delete-model">Cancel</button> <button type="button" id="confirm-delete-model">Delete model</button></div>` : '';
  return `<div class="field local-models"><label for="model">Installed local model</label>${picker}${state.localModels.length && state.localModelsError ? `<small class="error-text" role="alert">${escape(state.localModelsError)}</small>` : ''}${confirmation}${catalog}</div>`;
}
function updatePullProgressDOM(model, percent) {
  state.pullProgress[model] = percent;
  const btn = document.querySelector(`[data-pull-model="${CSS.escape(model)}"]`);
  if (btn) {
    btn.textContent = `${percent}%`;
    btn.classList.add('progress');
  }
  const card = btn?.closest('.model-card');
  let bar = card?.querySelector('.model-progress span');
  if (!bar && card) {
    const copy = card.querySelector('.model-card-copy');
    if (copy && !copy.querySelector('.model-progress')) {
      const div = document.createElement('div');
      div.className = 'model-progress';
      div.setAttribute('aria-label', `Downloading ${percent}%`);
      div.innerHTML = `<span style="width:${percent}%"></span>`;
      copy.appendChild(div);
      bar = div.querySelector('span');
    }
  }
  if (bar) {
    bar.style.width = `${percent}%`;
    const prog = bar.closest('.model-progress');
    if (prog) prog.setAttribute('aria-label', `Downloading ${percent}%`);
  }
}
function cloudModelField() {
  const provider = state.draftProvider;
  const info = providerInfo(provider);
  const savedModel = (state.model && state.provider===provider ? state.model : loadSavedModel(provider)) || info.model || '';
  const models = state.cloudModels[provider] || info.models || [];
  const loading = Boolean(state.cloudModelLoading[provider]);
  const error = state.cloudModelError[provider] || '';
  const free = models.filter(model => isFreeCloudModel(provider, model));
  const paid = models.filter(model => !isFreeCloudModel(provider, model));
  let picker = '';
  let status = '';
  if (loading) {
    picker = `<div class="installed-model-row"><select id="model" disabled><option>Loading ${escape(info.name)} models…</option></select><button type="button" class="browse-models" disabled>↻ Refresh</button></div>`;
    status = `Checking ${escape(info.name)} with your key…`;
  } else if (models.length) {
    const hasModels = free.length || paid.length;
    const options = [];
    if (free.length) {
      options.push(`<optgroup label="Free-tier models">${free.slice(0,120).map(m=> `<option value="${escape(m.id)}" title="${escape(m.id)}" ${m.id===savedModel?'selected':''}>${escape(modelOptionLabel(m, true, provider))}</option>`).join('')}</optgroup>`);
    }
    if (paid.length) {
      options.push(`<optgroup label="Other ${escape(info.name)} models">${paid.slice(0,240).map(m=> `<option value="${escape(m.id)}" title="${escape(m.id)}" ${m.id===savedModel?'selected':''}>${escape(modelOptionLabel(m, false, provider))}</option>`).join('')}</optgroup>`);
    }
    if (savedModel && !models.some(m=>m.id===savedModel)) options.unshift(`<option value="${escape(savedModel)}" title="${escape(savedModel)}" selected>${escape(compactModelName(savedModel))} · Saved</option>`);
    if (!hasModels) options.push(`<option value="${escape(savedModel)}">${escape(savedModel||'Select a model')}</option>`);
    picker = `<div class="installed-model-row"><select id="model">${options.join('')}</select><button type="button" class="browse-models" id="refresh-cloud-models">↻ Refresh</button></div>`;
    status = error ? `<span class="error-text">${escape(error)} Showing built-in models.</span>` : free.length && !paid.length
      ? `Showing ${free.length} free-tier models.`
      : free.length ? `Found ${models.length} models — known free-tier models are listed first.` : state.cloudModelsLoaded[provider] ? `Found ${models.length} models available to your key.` : `${models.length} recommended models. Add a key and refresh to load every available model.`;
  } else {
    picker = `<input id="model" value="${escape(savedModel)}" placeholder="e.g. moonshotai/kimi-k2 or anthropic/claude-3.5-sonnet:free" />`;
    status = error ? `<span class="error-text">${escape(error)}</span>` : `Add your ${escape(info.name)} key, then refresh the model list.`;
  }
  const access = info.accessNote ? `<small class="provider-access-note">${escape(info.accessNote)}</small>` : '';
  return `<div class="field"><label for="model">${escape(info.name)} model</label>${picker}<small>${status} <a href="${escape(info.modelsUrl)}" target="_blank" rel="noopener">Browse model catalog ↗</a></small>${access}</div>`;
}
function modal() {
  const info = providerInfo(state.draftProvider);
  const groups = ['Local','Cloud'];
  const providerOptions = groups.map(group => `<optgroup label="${group} models">${PROVIDERS.filter(item => item.group === group).map(item => `<option value="${item.id}" ${item.id===state.draftProvider?'selected':''}>${escape(item.name)}</option>`).join('')}</optgroup>`).join('');
  const endpointField = state.draftProvider==='local'
    ? `<div class="field"><label for="local-url">Ollama endpoint</label><input id="local-url" value="${escape(state.localUrl)}" /><small>Default: http://127.0.0.1:11434</small></div>`
    : '';
  const modelField = state.draftProvider==='local' ? localModelField() : cloudModelField();
  const savedKey = loadSavedKey(state.draftProvider) || (state.draftProvider===state.provider ? state.apiKey : '');
  const editingKey = Boolean(state.keyEditing[state.draftProvider]) || !savedKey;
  const draftKey = state.keyDrafts[state.draftProvider] || '';
  const confirmingRemove = state.keyRemoveConfirm === state.draftProvider;
  const keyDesc = info.env ? `Stored only on this device for ${escape(info.name)} model discovery and requests. You can also use <code>${escape(info.env)}</code> in the local server <code>.env</code> instead.` : '';
  const savedKeyActions = confirmingRemove
    ? '<div class="remove-key-confirm"><span>Remove key?</span><button type="button" id="cancel-remove-api-key">Cancel</button><button type="button" class="danger-link" id="confirm-remove-api-key">Remove key</button></div>'
    : '<div><button type="button" id="update-api-key">Update</button><button type="button" class="danger-link" id="remove-api-key">Remove</button></div>';
  const savedKeyView = `<div class="saved-key-row"><span class="saved-key"><b>✓ Saved</b><code>${escape(maskedKey(savedKey))}</code></span>${savedKeyActions}</div><small>${keyDesc}</small>`;
  const editKeyView = `<input id="api-key" type="password" value="${escape(draftKey)}" autocomplete="new-password" placeholder="${savedKey ? 'Paste a new key' : 'Paste key'}" /><small>${savedKey ? 'Your current saved key remains active until you enter a replacement and click Save provider.' : keyDesc}</small>${savedKey ? '<button type="button" class="cancel-key-update" id="cancel-key-update">Cancel key update</button>' : ''}`;
  const keyField = !info.env ? '' : `<div class="field"><div class="field-label-row"><label${editingKey ? ' for="api-key"' : ''}>${escape(info.name)} API key</label><a href="${escape(info.keyUrl)}" target="_blank" rel="noopener">Get API key ↗</a></div>${editingKey ? editKeyView : savedKeyView}</div>`;
  const intro = state.draftProvider==='local' ? 'Choose a provider. Local models are discovered from your Ollama installation.'
    : savedKey ? `${info.name} is connected on this device. Choose a model, or update the saved key only when you need to.`
    : `Add your ${info.name} API key once to list available models. CodePlus will reuse it on future visits to this provider.`;
  return `<div class="modal-backdrop"><section class="modal" role="dialog" aria-modal="true"><h2>AI provider settings</h2><p>${intro}</p><div class="field"><label for="provider">Provider</label><select id="provider">${providerOptions}</select></div>${endpointField}${modelField}${keyField}<div class="modal-actions"><button id="cancel-settings">Cancel</button><button class="primary" id="save-settings">Save provider</button></div></section></div>`;
}
function modelPickerModal() {
  const info = providerInfo(state.provider);
  const modelField = state.provider === 'local' ? localModelField() : cloudModelField();
  const note = state.provider === 'local'
    ? 'Choose an installed Ollama model. Provider and endpoint settings stay unchanged.'
    : `Showing only ${escape(info.name)} models. Only verified free-tier models are labeled Free tier.`;
  return `<div class="modal-backdrop"><section class="modal model-picker-modal" role="dialog" aria-modal="true"><h2>${escape(info.name)} models</h2><p>${note}</p>${modelField}<div class="model-picker-settings"><button type="button" id="open-provider-settings">Provider &amp; API key settings</button></div><div class="modal-actions"><button id="cancel-model-picker">Cancel</button><button class="primary" id="save-model-picker">Use model</button></div></section></div>`;
}
function openProviderSettings() {
  state.settingsOpen = true;
  state.modelPickerOpen = false;
  state.draftProvider = state.provider;
  state.apiKey = loadSavedKey(state.provider) || state.apiKey;
  state.keyDrafts = {};
  state.keyEditing = {};
  state.keyRemoveConfirm = '';
  state.catalogOpen = false;
  app();
}
function openModelPicker() {
  state.modelPickerOpen = true;
  state.settingsOpen = false;
  state.draftProvider = state.provider;
  state.catalogOpen = false;
  app();
}
function saveModelPicker() {
  const model = document.querySelector('#model')?.value.trim() || '';
  if (model) {
    state.model = fixInvalidModel(state.provider, model);
    localStorage.setItem('codeplus-model', state.model);
    saveProviderModel(state.provider, state.model);
  }
  state.modelPickerOpen = false;
  state.catalogOpen = false;
  app();
}
async function pickWorkspaceFolder() {
  if (window.__TAURI_INTERNALS__) { const picked = await tauriInvoke('pick_workspace_folder'); return picked ? { native: picked } : null; }
  if (isLocalHost()) {
    try {
      const response = await fetch('/api/pick-folder');
      if (response.ok) { const data = await response.json(); return data.path ? { native: data.path } : null; }
    } catch {}
  }
  if ('showDirectoryPicker' in window) { try { const handle = await window.showDirectoryPicker({ mode: 'readwrite' }); return { handle }; } catch (error) { if (error.name === 'AbortError') return null; throw error; } }
  return null;
}
async function scanWorkspace() {
  const paths = [];
  state.fileHandles = {};
  if (state.dirHandle) {
    const walk = async (handle, prefix, depth) => {
      if (depth > 10 || paths.length > 5000) return;
      for await (const [name, child] of handle.entries()) {
        if (FS_IGNORE.has(name)) continue;
        const rel = prefix ? `${prefix}/${name}` : name;
        if (child.kind === 'directory') await walk(child, rel, depth + 1);
        else if (isTextFile(name)) { state.fileHandles[rel] = child; paths.push(rel); }
      }
    };
    await walk(state.dirHandle, '', 0);
  } else if (state.dirPath) {
    paths.push(...await listWorkspaceFiles(state.dirPath));
  }
  paths.sort();
  state.treePaths = paths; state.folders = {};
}
async function ensureLoaded(path) {
  if (state.files[path] != null || state.loading.has(path)) return;
  state.loading.add(path);
  try {
    let content = '';
    if (state.dirHandle) { const handle = state.fileHandles[path]; content = handle ? await (await handle.getFile()).text() : ''; }
    else if (state.dirPath) { content = await readWorkspaceText(state.dirPath, path); }
    state.files[path] = content;
  } catch { state.files[path] = ''; }
  finally { state.loading.delete(path); if (state.active === path) app(); }
}
async function writeFileAt(path, content) {
  if (state.dirHandle) {
    let handle = state.fileHandles[path];
    if (!handle) {
      const parts = path.split('/'); const name = parts.pop();
      let dir = state.dirHandle;
      for (const segment of parts) dir = await dir.getDirectoryHandle(segment, { create: true });
      handle = await dir.getFileHandle(name, { create: true });
      state.fileHandles[path] = handle;
    }
    const writer = await handle.createWritable(); await writer.write(content); await writer.close();
  } else if (state.dirPath) {
    await writeWorkspaceText(state.dirPath, path, content);
  }
}
async function saveActiveFile() {
  const path = state.active;
  if (!path || fsMode()==='memory' || state.files[path]==null) return;
  try { await writeFileAt(path, state.files[path]); state.dirtyFiles.delete(path); if (state.active===path) state.dirty=false; app(); }
  catch (error) { state.vscodeNote = `Could not save ${path.split('/').pop()}: ${error.message || error}`; app(); }
}
async function getDevRoot() {
  if (state.dirPath) return state.dirPath;
  if (state.dirHandle) {
    const key = 'codeplus-dev-path:' + state.projectName;
    let p = localStorage.getItem(key) || '';
    if (p && /^https?:\/\//i.test(p)) { localStorage.removeItem(key); p = ''; }
    if (p) return p;
    // try to auto-find the project folder on disk by name (~/Projects etc.)
    try {
      const r = await fetch(`/api/find-project?name=${encodeURIComponent(state.projectName)}`);
      const d = await r.json();
      if (d.path) { localStorage.setItem(key, d.path); return d.path; }
    } catch {}
    try {
      const r = await fetch('/api/pick-folder');
      const d = await r.json();
      if (d.path) { localStorage.setItem(key, d.path); return d.path; }
    } catch {}
    p = prompt('Enter absolute path to "' + state.projectName + '" for dev server:\n(e.g. /Users/you/Projects/' + state.projectName + ')\nTip: Right-click folder in Finder → Get Info to copy path');
    if (p && p.trim()) {
      p = p.trim();
      if (/^https?:\/\//i.test(p)) { alert('That is a URL, not a folder path. Enter a disk path like /Users/you/Projects/' + state.projectName); return null; }
      if (!p.startsWith('/') && !/^[A-Za-z]:\\/.test(p)) { alert('Please enter an absolute path starting with /'); return null; }
      localStorage.setItem(key, p); return p;
    }
  }
  return null;
}

async function tryAutoStartDevServer() {
  if (!state.treePaths.includes('package.json')) return;
  try {
    if (!state.files['package.json']) await ensureLoaded('package.json');
    const text = state.files['package.json'] || '';
    const pkg = JSON.parse(text);
    if (!pkg.scripts || !pkg.scripts.dev) return;
  } catch { return; }
  if (state.dirPath) {
    try {
      state.devStarting = true; state.vscodeNote = 'Starting dev server (npm run dev)…'; app();
      let url;
      if (window.__TAURI_INTERNALS__) {
        url = await tauriInvoke('start_dev_server', { root: state.dirPath });
      } else {
        const res = await fetch('/api/dev/start', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ root: state.dirPath }) });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Could not start dev server');
        url = data.url;
      }
      state.previewUrl = url || 'http://localhost:3000/';
      state.customPreview = true;
      localStorage.setItem('codeplus-preview-url', state.previewUrl);
      state.devRunning = true; state.devStarting = false;
      state.vscodeNote = `Dev server running at ${state.previewUrl}`;
      app();
      setTimeout(() => { const f = document.querySelector('.preview-frame'); if (f) f.src = state.previewUrl; }, 3500);
    } catch (e) {
      state.devStarting = false; state.devRunning = false;
      state.previewUrl = 'http://localhost:3000/';
      state.customPreview = true;
      localStorage.setItem('codeplus-preview-url', state.previewUrl);
      let msg = e.message || String(e);
      if (msg.toLowerCase().includes('failed to fetch') || msg.toLowerCase().includes('fetch')) {
        msg = 'Could not connect to CodePlus server at 127.0.0.1:4173. Run `npm run dev` in the project root, or use the desktop app (which has its own server).';
      }
      state.vscodeNote = msg;
      app();
    }
  } else if (state.dirHandle) {
    state.previewUrl = 'http://localhost:3000/';
    state.customPreview = true;
    localStorage.setItem('codeplus-preview-url', state.previewUrl);
    state.vscodeNote = 'Preview set to http://localhost:3000/. Run `npm run dev` in your terminal to start the dev server, or click ▶ in the preview bar and enter the project path to auto-start.';
    app();
  }
}

async function toggleDevServer() {
  const root = await getDevRoot();
  if (!root && !state.dirPath) {
    state.vscodeNote = 'No project path for dev server. Enter absolute path when prompted.';
    app();
    return;
  }
  const targetRoot = root || state.dirPath;
  if (state.devRunning) {
    try {
      if (window.__TAURI_INTERNALS__) {
        await tauriInvoke('stop_dev_server', { root: targetRoot });
      } else {
        await fetch('/api/dev/stop', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ root: targetRoot }) });
      }
      state.devRunning = false; state.vscodeNote = 'Dev server stopped.'; app();
    } catch (e) { state.vscodeNote = e.message || String(e); app(); }
  } else {
    state.devStarting = true; app();
    try {
      let url;
      if (window.__TAURI_INTERNALS__) {
        url = await tauriInvoke('start_dev_server', { root: targetRoot });
      } else {
        // web: require local server at 127.0.0.1:4173 — not available on Vercel
        if (!isLocalHost()) throw new Error('Dev server is only available when running CodePlus locally (`npm run dev`) or in the desktop app. The Vercel web version cannot start a dev server.');
        let res;
        try {
          res = await fetch('/api/dev/start', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ root: targetRoot }) });
        } catch (err) {
          throw new Error('Could not connect to CodePlus server at 127.0.0.1:4173. Make sure you ran `npm run dev` in the project root. (' + (err.message||String(err)) + ')');
        }
        const data = await res.json().catch(()=>({}));
        if (!res.ok) throw new Error(data.error || 'Could not start dev server');
        url = data.url;
      }
      state.previewUrl = url || 'http://localhost:3000/';
      state.customPreview = true;
      localStorage.setItem('codeplus-preview-url', state.previewUrl);
      state.devRunning = true; state.devStarting = false;
      state.vscodeNote = `Dev server running at ${state.previewUrl}`;
      app();
      setTimeout(() => { const f = document.querySelector('.preview-frame'); if (f) f.src = state.previewUrl; }, 2500);
    } catch (e) {
      state.devStarting = false;
      let msg = e.message || String(e);
      if (msg.toLowerCase().includes('failed to fetch')) msg = 'Could not connect to CodePlus server at 127.0.0.1:4173. Run `npm run dev` in the project root, or use the desktop app.';
      state.vscodeNote = msg; app();
    }
  }
}

async function refreshDevStatus() {
  const hasDev = state.treePaths.includes('package.json') && state.customPreview;
  if (!hasDev) return;
  const stored = localStorage.getItem('codeplus-dev-path:' + state.projectName) || '';
  const root = state.dirPath || (/^https?:\/\//i.test(stored) ? '' : stored);
  if (!root) return;
    try {
      let running = false;
      if (window.__TAURI_INTERNALS__) {
        running = await tauriInvoke('dev_server_status', { root });
      } else {
        const r = await fetch(`/api/dev/status?root=${encodeURIComponent(root)}`);
        if (r.ok) {
          const data = await r.json();
          running = data.running;
          if (running && data.url && data.url !== state.previewUrl) {
            state.previewUrl = data.url;
            state.customPreview = true;
            localStorage.setItem('codeplus-preview-url', state.previewUrl);
            const f = document.querySelector('.preview-frame');
            if (f) f.src = state.previewUrl;
          }
        }
        else {
          try { const pr = await fetch(state.previewUrl, { method: 'HEAD', signal: AbortSignal.timeout(1200) }); running = pr.ok || (pr.status >= 200 && pr.status < 500); } catch {}
        }
      }
      if (running !== state.devRunning) { state.devRunning = running; state.devStarting = false; app(); }
    } catch {}
}

async function activateWorkspace(source) {
  await flushChatHistory();
  const prevRoot = state.dirPath || (state.projectName ? localStorage.getItem('codeplus-dev-path:' + state.projectName) : '') || '';
  const newRoot = source.native || '';
  if (prevRoot && newRoot && prevRoot !== newRoot && state.devRunning) {
    try {
      if (window.__TAURI_INTERNALS__) await tauriInvoke('stop_dev_server', { root: prevRoot });
      else await fetch('/api/dev/stop', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ root: prevRoot }) });
    } catch {}
    state.devRunning = false; state.devStarting = false;
    await new Promise(r => setTimeout(r, 800));
  } else if (prevRoot && !newRoot && state.devRunning) {
    // switching from native to FSA handle — stop old dev server as preview will change to manual
    try {
      if (window.__TAURI_INTERNALS__) await tauriInvoke('stop_dev_server', { root: prevRoot });
      else await fetch('/api/dev/stop', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ root: prevRoot }) });
    } catch {}
    state.devRunning = false; state.devStarting = false;
  }
  state.dirHandle = source.handle || null;
  state.dirPath = source.native || '';
  state.projectName = (source.handle && source.handle.name) || String(source.native || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || 'Workspace';
  state.files = {}; state.treePaths = []; state.dirty = false; state.dirtyFiles.clear(); state.editorClosed = false;
  await scanWorkspace();
  const remembered = localStorage.getItem('codeplus-active-file') || '';
  state.active = state.treePaths.includes(remembered) ? remembered : (state.treePaths.find(path => /(^|\/)(readme\.(md|txt|mdx)|index\.html)$/i.test(path)) || state.treePaths[0] || '');
  localStorage.setItem('codeplus-project-name', state.projectName);
  localStorage.setItem('codeplus-active-file', state.active);
  await loadChatHistory();
  app();
  if (state.active) await ensureLoaded(state.active);
  tryAutoStartDevServer();
  return state.treePaths.length;
}
async function openWorkspaceFolder() {
  try {
    const pick = await pickWorkspaceFolder();
    if (!pick) return;
    state.workspacesOpen = false;
    const count = await activateWorkspace(pick);
    await persistWorkspaceSession();
    state.vscodeNote = count ? `Opened ${state.projectName} from disk — ${count} files. It stays connected after a page refresh.` : 'No readable text files found in that folder.';
    app();
  } catch (error) { state.workspacesOpen = false; state.vscodeNote = error.message || String(error); app(); }
}
async function restoreWorkspace() {
  try {
    const savedNative = localStorage.getItem('codeplus-dir-path');
    if (savedNative && (window.__TAURI_INTERNALS__ || isLocalHost())) {
      const count = await activateWorkspace({ native: savedNative });
      state.vscodeNote = count ? `Reconnected ${state.projectName} — ${count} files.` : '';
      app();
      return;
    }
    if (!('showDirectoryPicker' in window)) return;
    const handle = await idbGet('workspace').catch(() => null);
    if (!handle) return;
    let permission = 'granted';
    try { permission = await handle.queryPermission({ mode: 'readwrite' }); } catch {}
    if (permission === 'granted') {
      const count = await activateWorkspace({ handle });
      if (count) { state.vscodeNote = `Reconnected ${state.projectName} — ${count} files.`; app(); }
    } else {
      state.pendingHandle = handle;
      state.pendingName = handle.name || 'your project folder';
      app();
    }
  } catch {}
}
async function reconnectWorkspace() {
  const handle = state.pendingHandle;
  if (!handle) return;
  try {
    let permission = 'prompt';
    try { permission = await handle.requestPermission({ mode: 'readwrite' }); } catch {}
    if (permission !== 'granted') throw new Error('Folder permission was not granted.');
    state.pendingHandle = null;
    const count = await activateWorkspace({ handle });
    state.vscodeNote = `Reconnected ${state.projectName} — ${count} files.`;
    app();
  } catch (error) { state.vscodeNote = error.message || 'Could not reconnect the folder.'; app(); }
}
function vscodeConsentModal() { return `<div class="modal-backdrop"><section class="modal vscode-consent" role="dialog" aria-modal="true"><h2>Start VS Code in CodePlus</h2><p>CodePlus will run the installed VS Code web server on <code>127.0.0.1:8765</code> and open the current CodePlus folder. It is available only on this Mac.</p><label class="license-check"><input id="vscode-license" type="checkbox" /> I accept the Visual Studio Code Server license terms.</label><div class="modal-actions"><button id="cancel-vscode">Cancel</button><button class="primary" id="start-vscode" disabled>Start workspace</button></div></section></div>`; }
function workspaceModal() {
  const canDisk = Boolean(window.__TAURI_INTERNALS__ || isLocalHost() || ('showDirectoryPicker' in window));
  return `<div class="modal-backdrop"><section class="modal workspace-modal" role="dialog" aria-modal="true"><h2>Workspaces</h2><p>Work directly on a folder from your disk — nothing is uploaded, files load as you click them (opencode-style). Or create a new starter project in a folder you choose.</p>${canDisk ? '<button type="button" class="import-project" id="open-folder"><strong>Open project folder…</strong><span>Pick any folder on this machine. CodePlus edits it in place.</span></button><div class="workspace-divider"><span>New project</span></div>' : ''}<form id="create-workspace"><div class="field"><label for="workspace-name">New project name</label><input id="workspace-name" value="New CodePlus project" required maxlength="80" /></div>${canDisk ? '<small class="workspace-help">You will pick the parent folder next. Starter files are written to disk immediately.</small>' : ''}<div class="modal-actions"><button type="button" id="cancel-workspaces">Cancel</button><button class="primary" type="submit">Create project</button></div></form>${canDisk ? '' : '<div class="workspace-divider"><span>or import a copy</span></div><label class="import-project" for="import-project"><strong>Import existing project folder</strong><span>Your browser cannot edit folders on disk, so a copy opens here.</span></label><input id="import-project" type="file" webkitdirectory directory multiple hidden />'}</section></div>`;
}
function formatActiveFile() {
  const source=state.files[state.active];
  const isJsx=/\.(?:[jt]sx?|jsx)$/i.test(state.active);
  const lines=((source ?? '').replace(/>\s*</g, '>\n<')).split('\n').map(line => line.trim()).filter((line, index, list) => line || (index > 0 && list[index - 1] !== ''));
  let depth=0;
  const formatted=lines.map(line => {
    const closesBlock=/^(<\/|[})]|\);)/.test(line);
    if (closesBlock) depth=Math.max(0,depth-1);
    const output=`${'  '.repeat(depth)}${line}`;
    const opensJsxTag=/^<[^/!][^>]*>$/.test(line) && !line.includes('</') && !line.endsWith('/>');
    const opensBlock=/[({]\s*$/.test(line) && !line.endsWith(');');
    if (!closesBlock && (opensJsxTag || opensBlock)) depth+=1;
    return output;
  }).join('\n');
  const normalized=formatted.endsWith('\n') ? formatted : `${formatted}\n`;
  state.files[state.active]=normalized;
  if (normalized !== source) state.dirtyFiles.add(state.active);
  state.dirty=state.dirtyFiles.has(state.active);
  state.vscodeNote=normalized !== source ? `Formatted ${state.active.split('/').at(-1)}. Press ⌘/Ctrl+S to save.` : 'Active file is already formatted.';
  app();
}
async function chooseWorkspace(name, files, note) {
  await flushChatHistory();
  state.files=files; state.active=Object.keys(files)[0] || ''; state.projectName=name; state.folders={}; state.dirty=false; state.dirtyFiles.clear(); state.workspacesOpen=false; state.vscodeNote=note;
  state.dirHandle=null; state.dirPath=''; state.treePaths=[]; state.pendingHandle=null;
  clearWorkspaceSession();
  localStorage.setItem('codeplus-project-name', name);
  await loadChatHistory();
  app();
}
async function createWorkspace(event) {
  event.preventDefault(); const raw=document.querySelector('#workspace-name').value.trim(); const name=raw.replace(/[\\/:*?"<>|]/g,'-').replace(/\s+/g,' ').slice(0,80);
  if (!name) return;
  const starters = structuredClone(initialFiles);
  const canDisk = Boolean(window.__TAURI_INTERNALS__ || isLocalHost() || ('showDirectoryPicker' in window));
  if (canDisk) {
    try {
      await flushChatHistory();
      const pick = await pickWorkspaceFolder();
      if (!pick) return;
      state.files = {}; state.treePaths = []; state.fileHandles = {}; state.dirty = false; state.dirtyFiles.clear(); state.editorClosed = false;
      if (pick.handle) {
        state.dirHandle = await pick.handle.getDirectoryHandle(name, { create: true });
        state.dirPath = ''; state.projectName = name;
        for (const [rel, content] of Object.entries(starters)) await writeFileAt(rel, content);
        await scanWorkspace();
      } else {
        const root = await createWorkspaceDirectory(pick.native, name);
        state.dirHandle = null; state.dirPath = root; state.projectName = name;
        for (const [rel, content] of Object.entries(starters)) await writeWorkspaceText(root, rel, content);
        await scanWorkspace();
      }
      state.active = Object.keys(starters)[0];
      state.workspacesOpen = false;
      localStorage.setItem('codeplus-project-name', name);
      await persistWorkspaceSession();
      await loadChatHistory();
      state.vscodeNote = `Created ${name} on disk and opened it.`;
      app();
      return;
    } catch (error) { state.workspacesOpen = false; state.vscodeNote = error.message || String(error); app(); return; }
  }
  await chooseWorkspace(name, starters, `Created ${name} in this browser session. Your browser cannot edit folders on disk.`);
}
async function importWorkspace(event) {
  const selected=Array.from(event.target.files || []).filter(file => isTextFile(file.name) && file.size <= 5_000_000).slice(0, 3000);
  if (!selected.length) return; const entries=await Promise.all(selected.map(async file => { const parts=(file.webkitRelativePath || file.name).split('/'); return [parts.length > 1 ? parts.slice(1).join('/') : file.name, await file.text()]; }));
  const files=Object.fromEntries(entries.filter(([name]) => name)); const root=(selected[0].webkitRelativePath || '').split('/')[0] || 'Imported project';
  await chooseWorkspace(root,files,`Imported ${Object.keys(files).length} files from ${root}.`);
}
function bind() {
  bindExternalLinks();
  document.querySelectorAll('[data-file]').forEach(row => listen(row, 'click', () => { const f = row.dataset.file; if (!f) return; const promptVal = document.querySelector('#prompt')?.value || ''; if (promptVal) state.draftPrompt = promptVal; state.active=f; state.editorClosed=false; state.dirty=state.dirtyFiles.has(f); localStorage.setItem('codeplus-active-file', f); app(); if (fsMode()!=='memory') ensureLoaded(f); }));
  document.querySelectorAll('[data-folder]').forEach(row => listen(row, 'click', () => { const folder=row.dataset.folder; state.folders[folder]=!state.folders[folder]; app(); }));
  listen(document.querySelector('#code'), 'input', e => { state.files[state.active]=e.target.value; state.dirty=true; state.dirtyFiles.add(state.active); document.querySelector('#line-numbers').innerHTML=lineNumbers(e.target.value); document.querySelector('#code-highlight').innerHTML=highlightCode(e.target.value); document.querySelector('.status span:nth-child(3)').textContent=`● ${state.dirtyFiles.size} unsaved — ⌘/Ctrl+S to save`; });
  listen(document.querySelector('#code'), 'scroll', e => { document.querySelector('#line-numbers').scrollTop=e.target.scrollTop; const highlight=document.querySelector('#code-highlight'); highlight.style.transform=`translate(${-e.target.scrollLeft}px, ${-e.target.scrollTop}px)`; });
  listen(document.querySelector('#code'), 'keydown', e => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase()==='s') { e.preventDefault(); saveActiveFile(); return; } if (e.key !== 'Tab') return; e.preventDefault(); const code=e.currentTarget; code.setRangeText('  ', code.selectionStart, code.selectionEnd, 'end'); code.dispatchEvent(new Event('input')); });
  listen(document.querySelector('#format'), 'click', formatActiveFile);
  listen(document.querySelector('#toggle-preview'), 'click', () => { state.previewHidden=!state.previewHidden; app(); });
  listen(document.querySelector('#toggle-files'), 'click', () => { state.filesHidden=!state.filesHidden; localStorage.setItem('codeplus-files-hidden',String(state.filesHidden)); app(); });
  listen(document.querySelector('#close-file'), 'click', () => { state.editorClosed=true; state.previewHidden=false; app(); });
  listen(document.querySelector('#new-file'), 'click', async () => { const name=prompt('File path, e.g. src/components/button.tsx'); if (!name) return; if (state.files[name]==null) state.files[name]='// New file\n'; if (fsMode()!=='memory') { try { await writeFileAt(name, state.files[name]); if (!state.treePaths.includes(name)) { state.treePaths.push(name); state.treePaths.sort(); } } catch (error) { state.vscodeNote=`Could not create ${name} on disk.`; app(); return; } } state.active=name; state.editorClosed=false; state.dirty=state.dirtyFiles.has(name); app(); });
  listen(document.querySelector('#export-project'), 'click', () => { const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([JSON.stringify(state.files,null,2)],{type:'application/json'}));a.download='codeplus-project.json';a.click();URL.revokeObjectURL(a.href); });
  listen(document.querySelector('#settings'), 'click', openProviderSettings);
  listen(document.querySelector('#open-vscode'), 'click', () => { state.vscodeConsent=true; app(); });
  listen(document.querySelector('#workspaces'), 'click', () => { state.workspacesOpen=true; app(); });
  document.querySelectorAll('#preview-form').forEach(form => listen(form, 'submit', event => { event.preventDefault(); const value=form.querySelector('#preview-url').value.trim(); try { const url=new URL(value); if (!['http:', 'https:'].includes(url.protocol)) throw new Error(); state.previewUrl=url.href; state.customPreview=true; localStorage.setItem('codeplus-preview-url',state.previewUrl); app(true); } catch { form.querySelector('#preview-url').setCustomValidity('Enter a valid http:// or https:// URL.'); form.querySelector('#preview-url').reportValidity(); form.querySelector('#preview-url').setCustomValidity(''); } }));
  document.querySelectorAll('#open-preview').forEach(button => listen(button, 'click', async () => { try { await openExternalUrl(document.querySelector('#preview-url').value.trim()); } catch (error) { state.vscodeNote=error.message || 'Enter a valid preview URL first.'; app(); } }));
  listen(document.querySelector('#dev-server-btn'), 'click', toggleDevServer);
  listen(document.querySelector('#preview-start-dev'), 'click', toggleDevServer);
  listen(document.querySelector('#preview-reload'), 'click', () => { const f=document.querySelector('.preview-frame'); if(f) f.src=state.previewUrl; else app(true); });
  listen(document.querySelector('#composer'), 'submit', sendPrompt);
  listen(document.querySelector('#stop'), 'click', stopResponse);
  document.querySelectorAll('[data-copy-message]').forEach(button => listen(button, 'click', () => copyChatMessage(button.dataset.copyMessage)));
  document.querySelectorAll('[data-edit-message]').forEach(button => listen(button, 'click', () => editChatMessage(button.dataset.editMessage)));
  listen(document.querySelector('#cancel-message-edit'), 'click', cancelMessageEdit);
  listen(document.querySelector('#prompt'), 'keydown', event => {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    document.querySelector('#composer').requestSubmit();
  });
  listen(document.querySelector('#prompt'), 'input', event => { state.draftPrompt = event.target.value; });
  // opencode-style: drag & drop / paste directly on composer to attach images/files
  const composer = document.querySelector('#composer');
  const promptTextarea = document.querySelector('#prompt');
  listen(composer, 'dragover', e => { e.preventDefault(); composer.classList.add('drag-over'); });
  listen(composer, 'dragleave', e => { e.preventDefault(); composer.classList.remove('drag-over'); });
  listen(composer, 'drop', e => { e.preventDefault(); composer.classList.remove('drag-over'); handleFiles(e.dataTransfer.files); });
  listen(promptTextarea, 'paste', e => { const items = e.clipboardData?.items; if (items) handleFiles([...items].filter(i => i.type.startsWith('image/')).map(i => i.getAsFile()).filter(Boolean)); });
  document.querySelectorAll('[data-prompt]').forEach(btn => listen(btn, 'click', () => {document.querySelector('#prompt').value=btn.dataset.prompt;document.querySelector('#composer').requestSubmit();}));
  listen(document.querySelector('#plus-btn'), 'click', () => { state.plusOpen=!state.plusOpen; app(); });
  document.querySelectorAll('[data-plus-action]').forEach(btn => listen(btn, 'click', () => {
    const action=btn.dataset.plusAction;
    state.plusOpen=false;
    if (action==='files') { openComputerFilePicker(); }
    else if (action==='shell') { state.shellOpen=!state.shellOpen && !state.shellBusy; }
    app();
  }));
  listen(document.querySelector('#model-chip'), 'click', openModelPicker);
  listen(document.querySelector('#update-btn'), 'click', doUpdate);
  document.querySelectorAll('[data-unpin]').forEach(btn => listen(btn, 'click', () => { state.attached=state.attached.filter(p=>p!==btn.dataset.unpin); app(); }));
  document.querySelectorAll('[data-unpin-shell]').forEach(btn => listen(btn, 'click', () => { state.shellOutputs=state.shellOutputs.filter(s=>String(s.id)!==btn.dataset.unpinShell); app(); }));
  if (state.attachPickerOpen) {
    listen(document.querySelector('#cancel-attach'), 'click', () => { state.attachPickerOpen=false; app(); });
    listen(document.querySelector('#apply-attach'), 'click', () => { state.attachPickerOpen=false; state.vscodeNote=`Attached ${state.attached.length + state.uploads.length} item(s).`; app(); });
    listen(document.querySelector('#attach-search'), 'input', event => { const query=event.target.value.toLowerCase(); document.querySelectorAll('.attach-row').forEach(row => row.classList.toggle('hidden', !row.textContent.toLowerCase().includes(query))); });
    document.querySelectorAll('[data-attach]').forEach(box => listen(box, 'change', () => {
      const path=box.dataset.attach;
      if (box.checked) { if (!state.attached.includes(path) && state.attached.length<10) state.attached.push(path); }
      else state.attached=state.attached.filter(p=>p!==path);
      box.closest('.attach-row')?.classList.toggle('checked', box.checked);
      const applyBtn=document.querySelector('#apply-attach');
      if (applyBtn) applyBtn.textContent='Attach'+((state.attached.length + state.uploads.length)?` (${state.attached.length + state.uploads.length})`:'');
    }));
    document.querySelectorAll('[data-attach-upload]').forEach(box => listen(box, 'change', () => {
      const id=box.dataset.attachUpload;
      if (!box.checked) { state.uploads=state.uploads.filter(u=>u.id!==id); app(); }
    }));
    // file upload handlers
    const dropzone=document.querySelector('#upload-dropzone');
    const fileInput=document.querySelector('#file-upload');
    listen(dropzone, 'click', () => fileInput?.click());
    listen(dropzone, 'dragover', e => { e.preventDefault(); dropzone.classList.add('drag-over'); });
    listen(dropzone, 'dragleave', e => { e.preventDefault(); dropzone.classList.remove('drag-over'); });
    listen(dropzone, 'drop', e => { e.preventDefault(); dropzone.classList.remove('drag-over'); handleFiles(e.dataTransfer.files); });
    listen(fileInput, 'change', e => { handleFiles(e.target.files); fileInput.value=''; });
    // paste handler on composer
    const composer=document.querySelector('#composer');
    listen(composer, 'paste', e => { const items=e.clipboardData?.items; if(items) handleFiles([...items].filter(i=>i.type.startsWith('image/')).map(i=>i.getAsFile()).filter(Boolean)); });
  }
  if (state.shellOpen) {
    listen(document.querySelector('#shell-run'), 'click', runShellCommand);
    listen(document.querySelector('#shell-close'), 'click', () => { state.shellOpen=false; app(); });
    listen(document.querySelector('#shell-input'), 'keydown', e => { if (e.key==='Enter' && !e.isComposing) { e.preventDefault(); e.stopPropagation(); runShellCommand(); } });
  }
  if (state.settingsOpen) {
    listen(document.querySelector('#cancel-settings'), 'click',()=>{state.settingsOpen=false;state.catalogOpen=false;state.keyDrafts={};state.keyEditing={};state.keyRemoveConfirm='';state.modelDeleteConfirm=null;app();});
    listen(document.querySelector('#save-settings'), 'click',saveSettings);
    listen(document.querySelector('#provider'), 'change', e => {
      const prev = state.draftProvider;
      const curKeyInput = document.querySelector('#api-key');
      if (curKeyInput && prev) state.keyDrafts[prev] = curKeyInput.value;
      state.draftProvider=e.target.value;
      state.keyRemoveConfirm='';
      state.catalogOpen=false;
      app();
      if (providerInfo(state.draftProvider).group==='Cloud') {
        const k = state.keyDrafts[state.draftProvider]?.trim() || loadSavedKey(state.draftProvider) || (state.provider===state.draftProvider ? state.apiKey : '');
        if (k && !state.cloudModelsLoaded[state.draftProvider] && !state.cloudModelLoading[state.draftProvider]) refreshCloudModels(state.draftProvider, k);
      }
    });
    listen(document.querySelector('#local-url'), 'input', e => { state.localUrl=e.target.value; state.localModelsLoaded=false; });
    listen(document.querySelector('#api-key'), 'input', e => {
      const v = e.target.value;
      state.keyDrafts[state.draftProvider] = v;
      if (providerInfo(state.draftProvider).group==='Cloud') {
        state.cloudModelsLoaded[state.draftProvider]=false;
        state.cloudModelError[state.draftProvider]='';
      }
    });
    listen(document.querySelector('#update-api-key'), 'click', () => {
      state.keyEditing[state.draftProvider] = true;
      state.keyDrafts[state.draftProvider] = '';
      app();
      requestAnimationFrame(() => document.querySelector('#api-key')?.focus());
    });
    listen(document.querySelector('#cancel-key-update'), 'click', () => {
      delete state.keyEditing[state.draftProvider];
      delete state.keyDrafts[state.draftProvider];
      app();
    });
    listen(document.querySelector('#remove-api-key'), 'click', () => {
      state.keyRemoveConfirm = state.draftProvider;
      app();
    });
    listen(document.querySelector('#cancel-remove-api-key'), 'click', () => {
      state.keyRemoveConfirm = '';
      app();
    });
    listen(document.querySelector('#confirm-remove-api-key'), 'click', () => {
      const provider = state.draftProvider;
      removeProviderKey(provider);
      if (provider === state.provider) state.apiKey = '';
      state.keyDrafts[provider] = '';
      state.keyEditing[provider] = true;
      state.keyRemoveConfirm = '';
      if (providerInfo(provider).group==='Cloud') {
        state.cloudModels[provider]=structuredClone(providerInfo(provider).models || []);
        state.cloudModelsLoaded[provider]=false;
        state.cloudModelError[provider]='';
      }
      app();
    });
    listen(document.querySelector('#browse-local-models'), 'click', () => { state.catalogOpen=true; app(); });
    listen(document.querySelector('#catalog-search'), 'input', event => { const query=event.target.value.toLowerCase(); document.querySelectorAll('.model-card').forEach(card => card.classList.toggle('hidden', !card.textContent.toLowerCase().includes(query))); });
    document.querySelectorAll('[data-pull-model]').forEach(button => listen(button, 'click', () => pullLocalModel(button.dataset.pullModel, document.querySelector('#local-url').value)));
    bindLocalModelDeletion(() => document.querySelector('#local-url')?.value || state.localUrl);
    listen(document.querySelector('#refresh-cloud-models'), 'click', () => {
      const provider = state.draftProvider;
      const k = document.querySelector('#api-key')?.value.trim() || state.keyDrafts[provider]?.trim() || loadSavedKey(provider) || '';
      refreshCloudModels(provider, k);
    });
    // Enter validates the key and refreshes the selected provider's model list.
    listen(document.querySelector('#api-key'), 'keydown', e => {
      if (e.key==='Enter' && providerInfo(state.draftProvider).group==='Cloud') { e.preventDefault(); const k=document.querySelector('#api-key')?.value.trim()||''; refreshCloudModels(state.draftProvider, k); }
    });
    if (state.draftProvider==='local' && !state.localModelsLoaded && !state.localModelsLoading) refreshLocalModels(state.localUrl);
    if (providerInfo(state.draftProvider).group==='Cloud' && !state.cloudModelsLoaded[state.draftProvider] && !state.cloudModelLoading[state.draftProvider]) {
      const k = document.querySelector('#api-key')?.value.trim() || state.keyDrafts[state.draftProvider]?.trim() || loadSavedKey(state.draftProvider) || (state.provider===state.draftProvider ? state.apiKey : '');
      if (k) refreshCloudModels(state.draftProvider, k);
    }
  }
  if (state.modelPickerOpen) {
    listen(document.querySelector('#cancel-model-picker'), 'click', () => { state.modelPickerOpen=false;state.catalogOpen=false;state.modelDeleteConfirm=null;app(); });
    listen(document.querySelector('#save-model-picker'), 'click', saveModelPicker);
    listen(document.querySelector('#open-provider-settings'), 'click', openProviderSettings);
    listen(document.querySelector('#browse-local-models'), 'click', () => { state.catalogOpen=true; app(); });
    listen(document.querySelector('#catalog-search'), 'input', event => { const query=event.target.value.toLowerCase(); document.querySelectorAll('.model-card').forEach(card => card.classList.toggle('hidden', !card.textContent.toLowerCase().includes(query))); });
    document.querySelectorAll('[data-pull-model]').forEach(button => listen(button, 'click', () => pullLocalModel(button.dataset.pullModel, state.localUrl)));
    bindLocalModelDeletion(() => state.localUrl);
    listen(document.querySelector('#refresh-cloud-models'), 'click', () => refreshCloudModels(state.provider, loadSavedKey(state.provider) || state.apiKey));
    if (state.provider==='local' && !state.localModelsLoaded && !state.localModelsLoading) refreshLocalModels(state.localUrl);
    if (providerInfo(state.provider).group==='Cloud' && !state.cloudModelsLoaded[state.provider] && !state.cloudModelLoading[state.provider]) {
      const key = loadSavedKey(state.provider) || state.apiKey;
      if (key) refreshCloudModels(state.provider, key);
    }
  }
  if (state.vscodeConsent) { listen(document.querySelector('#cancel-vscode'), 'click',()=>{state.vscodeConsent=false;app();}); const check=document.querySelector('#vscode-license'); const start=document.querySelector('#start-vscode'); listen(check, 'change',()=>{start.disabled=!check.checked;}); listen(start, 'click',startVSCodeWeb); }
  if (state.workspacesOpen) { listen(document.querySelector('#cancel-workspaces'), 'click',()=>{state.workspacesOpen=false;app();}); listen(document.querySelector('#open-folder'), 'click', openWorkspaceFolder); listen(document.querySelector('#create-workspace'), 'submit',createWorkspace); listen(document.querySelector('#import-project'), 'change',importWorkspace); }
  listen(document.querySelector('#reconnect-ws'), 'click', reconnectWorkspace);
  if (state.vscodeView) listen(document.querySelector('#close-vscode'), 'click',()=>{state.vscodeView=false;app();});
}
async function localModelRequest(action, payload) { if(window.__TAURI_INTERNALS__){const command={list:'list_local_models',delete:'delete_local_model'}[action];return tauriInvoke(command, payload);}const path=action==='list'?`/api/models?endpoint=${encodeURIComponent(payload.endpoint || state.localUrl)}`:'/api/models/delete';const response=await fetch(path,{method:action==='list'?'GET':'POST',headers:action==='list'?undefined:{'Content-Type':'application/json'},body:action==='list'?undefined:JSON.stringify(payload)});const data=await response.json();if(!response.ok)throw new Error(data.error || `Could not ${action} local model`);return action==='list'?data.models:data; }
async function streamPullLocalModel(model, endpoint) {
  const payload={model,endpoint:endpoint || state.localUrl};
  if(window.__TAURI_INTERNALS__){
    const unlisten=await tauriListen('ollama-pull-progress',event=>{const data=event.payload || {};if(data.model!==model)return;if(Number.isFinite(data.total)&&data.total>0&&Number.isFinite(data.completed)){const percent=Math.min(99,Math.round(data.completed/data.total*100));if(percent!==state.pullProgress[model]){updatePullProgressDOM(model, percent);}}});
    try { await tauriInvoke('pull_local_model',payload);updatePullProgressDOM(model, 100); } finally { await unlisten(); }
    return;
  }
  const response=await fetch('/api/models/pull',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
  if(!response.ok){const data=await response.json().catch(()=>({}));throw new Error(data.error || `Could not download ${model}`);}
  if(!response.body){updatePullProgressDOM(model, 100);return;}
  const reader=response.body.getReader();const decoder=new TextDecoder();let buffer='';
  const applyStatus=line=>{if(!line)return;const data=JSON.parse(line);if(data.error)throw new Error(data.error);if(Number.isFinite(data.total)&&data.total>0&&Number.isFinite(data.completed)){const percent=Math.min(99,Math.round(data.completed/data.total*100));if(percent!==state.pullProgress[model]){updatePullProgressDOM(model, percent);}}};
  while(true){const {done,value}=await reader.read();buffer+=decoder.decode(value || new Uint8Array(),{stream:!done});const lines=buffer.split(/\r?\n/);buffer=lines.pop() || '';for(const line of lines)applyStatus(line);if(done)break;}
  applyStatus(buffer);updatePullProgressDOM(model, 100);
}
async function startVSCodeWeb() { const button=document.querySelector('#start-vscode');button.disabled=true;button.textContent='Starting…';try {let data;if(window.__TAURI_INTERNALS__){data={url:await tauriInvoke('start_vscode_web',{acceptLicense:true})};}else{const response=await fetch('/api/vscode/web',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({acceptLicense:true})});data=await response.json();if(!response.ok)throw new Error(data.error || 'Could not start VS Code.');}state.vscodeUrl=data.url;state.vscodeConsent=false;state.vscodeView=true;}catch(error){state.vscodeConsent=false;state.vscodeNote=error.message || 'Could not start VS Code.';}app();}
async function refreshLocalModels(endpoint) { state.localModelsLoading=true; state.localModelsError=''; app(); try { const models=await localModelRequest('list',{endpoint:endpoint || state.localUrl}); state.localModels=models || []; state.localModelsLoaded=true; if(state.localModels.length && !state.localModels.some(item=>item.name===state.model)) state.model=state.localModels[0].name; if(!state.localModels.length) state.localModelsError='No Ollama models are installed yet. Download one from the list below.'; } catch(error) { state.localModels=[]; state.localModelsLoaded=true; state.localModelsError=error.message || 'Could not connect to Ollama.'; } finally { state.localModelsLoading=false; app(); } }
async function fetchCloudModels(provider, key) {
  const k = (key || '').trim();
  const info = providerInfo(provider);
  if (!k) throw new Error(`Enter your ${info.name} API key first.`);
  if (window.__TAURI_INTERNALS__) {
    return tauriInvoke('list_provider_models', { provider, apiKey: k });
  }
  const r = await fetch('/api/provider-models', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({provider,apiKey:k}) });
  const d = await r.json().catch(()=>({}));
  if (!r.ok) throw new Error(d.error || `Could not fetch ${info.name} models`);
  return d.models || [];
}
async function refreshCloudModels(provider, key) {
  const info = providerInfo(provider);
  const k = (key || document.querySelector('#api-key')?.value.trim() || loadSavedKey(provider) || '').trim();
  if (!k) { state.cloudModelError[provider]=`Paste your ${info.name} key to load available models.`; app(); return; }
  state.cloudModelLoading[provider]=true; state.cloudModelError[provider]=''; app();
  try {
    const models = await fetchCloudModels(provider, k);
    const curated = new Map((info.models || []).map(model => [model.id, model]));
    const decorated = models.map(model => curated.get(model.id)?.free ? {...model, free:true} : model);
    decorated.sort((a,b)=> Number(isFreeCloudModel(provider, b)) - Number(isFreeCloudModel(provider, a)) || String(a.name || a.id).localeCompare(String(b.name || b.id)));
    state.cloudModels[provider]=decorated.length ? decorated : structuredClone(info.models || []);
    state.cloudModelsLoaded[provider]=true;
    if (!models.length) state.cloudModelError[provider]=`No models returned. Check your ${info.name} key.`;
  } catch (error) {
    state.cloudModels[provider]=structuredClone(info.models || []);
    state.cloudModelsLoaded[provider]=true;
    state.cloudModelError[provider]=error.message || `Could not fetch ${info.name} models. Check your key.`;
  } finally { state.cloudModelLoading[provider]=false; app(); }
}
function localModelError(error, fallback) {
  return typeof error === 'string' && error.trim() ? error : error?.message || fallback;
}
function bindLocalModelDeletion(getEndpoint) {
  document.querySelectorAll('[data-delete-model]').forEach(button => listen(button, 'click', () => {
    if (state.removingModel) return;
    state.modelDeleteConfirm = { model: button.dataset.deleteModel, endpoint: getEndpoint() };
    app();
  }));
  listen(document.querySelector('#cancel-delete-model'), 'click', () => { state.modelDeleteConfirm = null; app(); });
  listen(document.querySelector('#confirm-delete-model'), 'click', () => {
    const pending = state.modelDeleteConfirm;
    state.modelDeleteConfirm = null;
    if (pending) void deleteLocalModel(pending.model, pending.endpoint);
  });
}
async function pullLocalModel(model, endpoint) {
  if (!model || Number.isFinite(state.pullProgress[model])) return;
  state.pullProgress[model] = 0;
  state.localModelsError = '';
  app();
  try {
    await streamPullLocalModel(model, endpoint);
    state.localModelsLoaded = false;
    await refreshLocalModels(endpoint || state.localUrl);
    // Keep the user's provider and dialog choices while downloads run in parallel.
    if (state.provider === 'local') localStorage.setItem('codeplus-model', state.model || model);
  } catch (error) {
    state.localModelsError = localModelError(error, `Could not download ${model}.`);
  } finally {
    delete state.pullProgress[model];
    app();
  }
}
async function deleteLocalModel(model, endpoint) {
  if (!model || state.removingModel) return;
  state.removingModel = model;
  state.localModelsError = '';
  app();
  try {
    await localModelRequest('delete', { model, endpoint: endpoint || state.localUrl });
    if (state.model === model) { state.model = ''; localStorage.removeItem('codeplus-model'); }
    state.localModelsLoaded = false;
    await refreshLocalModels(endpoint || state.localUrl);
    if (state.provider === 'local' && state.model) localStorage.setItem('codeplus-model', state.model);
  } catch (error) {
    state.localModelsError = localModelError(error, `Could not delete ${model}.`);
  } finally {
    state.removingModel = '';
    app();
  }
}
function scrollChatToBottom() { requestAnimationFrame(() => { const chat=document.querySelector('#chat'); if (chat) chat.scrollTop=chat.scrollHeight; }); }
function stoppedError() { const error = new Error('Stopped by you.'); error.name = 'AbortError'; return error; }
function beginTurnCancellation() {
  state.stopRequested = false;
  state.abortController = new AbortController();
  state.stopPromise = new Promise((_, reject) => { state.stopReject = reject; });
}
function ensureTurnActive() { if (state.stopRequested) throw stoppedError(); }
function waitForTurn(operation) {
  ensureTurnActive();
  return state.stopPromise ? Promise.race([Promise.resolve(operation), state.stopPromise]) : Promise.resolve(operation);
}
function stopResponse() {
  if (!state.sending || state.stopRequested) return;
  state.stopRequested = true;
  state.abortController?.abort();
  state.stopReject?.(stoppedError());
}
async function callModel(messagesForApi, context, requireTool = false) {
  const source = state.turnProvider || state;
  const activeKey = source.apiKey || loadSavedKey(source.provider);
  const payload = { provider: source.provider, model: source.model, localUrl: source.localUrl, apiKey: activeKey, toolsEnabled: source.toolsEnabled !== false, requireTool: Boolean(requireTool), context: context?.length?context:undefined, messages: messagesForApi };
  if (window.__TAURI_INTERNALS__) {
    const res = await waitForTurn(tauriInvoke('ask_model', { request: payload }));
    // Tauri now returns {content, tool_calls} (AskResponse) or string for backward compat
    if (typeof res === 'string') return { content: res, tool_calls: null };
    if (res && typeof res === 'object' && 'content' in res) return { content: res.content || '', tool_calls: res.tool_calls || null };
    if (res && res.answer) return { content: res.answer, tool_calls: res.tool_calls || null };
    return { content: String(res||''), tool_calls: null };
  } else {
    const r = await waitForTurn(fetch('/api/chat', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload), signal: state.abortController?.signal }));
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'Model request failed');
    return { content: d.answer || d.content || '', tool_calls: d.tool_calls || null };
  }
}
async function sendPrompt(event) {
  event.preventDefault(); if (state.sending) return;
  const input = document.querySelector('#prompt');
  const content = input.value.trim(); if (!content && state.uploads.length === 0) return;
  let providerDefault = providerInfo(state.provider).model;
  if (!state.model && providerDefault) state.model = providerDefault;
  // auto-fix legacy invalid model like openrouter/free
  state.model = fixInvalidModel(state.provider, state.model);
  if (state.provider === 'openrouter' && (!state.model || state.model === 'openrouter/free')) state.model = 'google/gemma-3-4b-it:free';
  if (!state.model) { appendMessage({role:'assistant',content:'Choose an installed model in AI provider settings first.',error:true}); app(); scrollChatToBottom(); return; }
  // include uploaded images in user message
  const images = state.uploads.filter(u => u.type.startsWith('image/')).map(u => ({ type: 'image_url', image_url: { url: u.data } }));
  const pendingUploads = [...state.uploads];
  const previousMode = [...state.messages].reverse().find(message => message.role === 'user')?.mode || '';
  const toolsEnabled = promptNeedsTools(content, { hasAttachments: pendingUploads.length > 0, previousMode });
  const requiresMutation = promptRequestsMutation(content);
  const turnMode = toolsEnabled ? 'agent' : 'chat';
  const editedFrom = state.editingMessageId;
  const userMsg = appendMessage({ role:'user', mode: turnMode, content: content || (images.length ? '' : undefined), ...(images.length ? { images } : {}), ...(editedFrom ? { editedFrom } : {}) });
  input.value = '';
  state.draftPrompt = '';
  state.editingMessageId = '';
  state.uploads = []; // clear uploads after sending
  state.turnProvider = { provider: state.provider, model: state.model, localUrl: state.localUrl, apiKey: loadSavedKey(state.provider) || state.apiKey, toolsEnabled };
  state.sending = true; state.todos = []; beginTurnCancellation(); app(); scrollChatToBottom();
  try {
    const context = toolsEnabled ? await waitForTurn(buildContext(pendingUploads)) : [];
    let apiMessages = toolsEnabled
      ? [{role:'system',content: AGENT_SYSTEM_PROMPT}, ...apiHistory(state.messages, state.turnProvider.provider, state.turnProvider.model)]
      : [{role:'system',content: CASUAL_SYSTEM_PROMPT}, ...casualHistory(state.messages)];
    if (toolsEnabled) {
      const wsInfo = `Workspace: ${state.projectName} (${fsMode()}), ${fsMode()==='memory'?Object.keys(state.files).length:state.treePaths.length} files. Active: ${state.active || 'none'}.`;
      apiMessages[0].content += '\n\n' + wsInfo;
      const contract = requestContract(content);
      if (contract) apiMessages[0].content += `\n\n${contract}`;
      if (requiresMutation) apiMessages[0].content += '\n\nThis turn requires an actual workspace change. Inspect the real files and use edit/write; do not return tutorial or sample code.';
    }
    let steps = 0; const maxSteps = toolsEnabled ? 26 : 1; let completed = false;
    const toolAudit = createToolAudit(content, { requiresMutation });
    const toolSeen = new Map(); // opencode doom_loop: same tool+args 3x
    while (steps < maxSteps) {
      ensureTurnActive();
      steps++;
      const requireTool = requiresMutation && !toolAudit.explored && toolAudit.changed.size === 0;
      const result = await callModel(apiMessages, context, requireTool);
      ensureTurnActive();
      const toolCalls = Array.isArray(result.tool_calls) ? result.tool_calls.filter(call => call && call.name).map((call, index) => ({
        id: call.id || `call_${steps}_${index}_${Date.now().toString(36)}`,
        name: normalizeToolName(call.name),
        arguments: call.arguments && typeof call.arguments === 'object' ? call.arguments : {},
        ...(call.thought_signature ? { thought_signature: call.thought_signature } : {})
      })) : [];
      const hasTools = toolCalls.length > 0;
      if (hasTools) {
        if (!toolsEnabled) throw new Error('The model attempted a workspace tool during a normal chat turn. Please retry. No tool was executed.');
        const assistantMsg = { role:'assistant', content: result.content||'', tool_calls: toolCalls };
        appendMessage(assistantMsg);
        apiMessages.push({ role:'assistant', content: result.content||'', tool_calls: toolCalls });
        app();
        // execute each tool sequentially with doom-loop guard
        for (const tc of toolCalls) {
          const key = toolLoopKey(toolAudit, tc.name, tc.arguments || {});
          const cnt = (toolSeen.get(key) || 0) + 1;
          toolSeen.set(key, cnt);
          let output = '';
          if (cnt >= 3) {
            output = `Doom loop detected: You have already called ${tc.name} with the same arguments ${cnt} times. Stop repeating. For read: use the cached content you already have. For write/edit: you have already written — summarize the changes and stop.`;
          } else {
            try { output = await waitForTurn(executeTool(tc.name, tc.arguments || {}, toolAudit)); } catch (e) { if (e.name === 'AbortError') throw e; output = `Error: ${e.message || String(e)}`; }
          }
          const toolMsg = { role:'tool', content: String(output).slice(0, 30000), tool_call_id: tc.id, name: tc.name };
          appendMessage(toolMsg);
          apiMessages.push({ role:'tool', content: toolMsg.content, tool_call_id: tc.id, name: tc.name });
          app();
        }
        continue;
      }
      // final answer, no tools
      if (!result.content?.trim()) throw new Error('The model returned an empty response without a tool call. Retry, or select another model. No completion was reported.');
      if (needsActionReview(toolAudit, result.content)) {
        if (toolAudit.actionReviewRequests >= 2) throw new Error('The agent returned instructions instead of operating on the workspace after two retries. No file was changed.');
        apiMessages.push({ role:'assistant', content: result.content });
        apiMessages.push({ role:'user', content: actionReviewMessage(content, toolAudit) });
        continue;
      }
      if (needsRequirementReview(toolAudit, state.turnProvider.provider)) {
        if (toolAudit.reviewRequests >= 2) throw new Error(`The agent could not verify its edits after two attempts. Unverified files: ${[...toolAudit.changed].filter(path => !toolAudit.postChangeInspected.has(path)).join(', ')}. The edits are preserved for review.`);
        apiMessages.push({ role:'assistant', content: result.content });
        apiMessages.push({ role:'user', content: requirementReviewMessage(content, toolAudit) });
        continue;
      }
      appendMessage({ role:'assistant', mode: turnMode, content: result.content });
      completed = true;
      break;
    }
    if (!completed && steps >= maxSteps) appendMessage({ role:'assistant', content: `Agent reached the safety limit (${maxSteps} model steps). Review the changes and continue if needed.`, error: true });
  } catch (error) {
    if (state.stopRequested || error?.name === 'AbortError') appendMessage({role:'assistant',content:'Stopped.',stopped:true});
    else appendMessage({role:'assistant',content: modelError(error, [state.turnProvider?.apiKey, state.apiKey]),error:true});
  } finally {
    state.sending=false; state.turnProvider=null; state.stopRequested=false; state.abortController=null; state.stopPromise=null; state.stopReject=null; app();
    persistChatHistory();
    // refresh file tree if edits happened
    if (fsMode()!=='memory' && state.treePaths.length) { try { await scanWorkspace(); app(); } catch {} }
  }
}
function saveSettings() {
  const model=document.querySelector('#model');
  const info=providerInfo(state.draftProvider);
  const previousProvider=state.provider;
  const previousModel=state.model;
  const previousKey=loadSavedKey(state.draftProvider) || (previousProvider===state.draftProvider ? state.apiKey : '');
  state.provider=state.draftProvider;
  let m = model?.value.trim() || (previousProvider===state.provider ? previousModel : '') || info.model || '';
  m = fixInvalidModel(state.provider, m);
  state.model = m;
  state.localUrl=document.querySelector('#local-url')?.value.trim() || state.localUrl || 'http://127.0.0.1:11434';
  const keyInput=document.querySelector('#api-key');
  const replacementKey=(keyInput?.value || state.keyDrafts[state.provider] || '').trim();
  if (replacementKey) saveProviderKey(state.provider, replacementKey);
  // A blank field never clears an existing key. Removal is an explicit separate action.
  state.apiKey=replacementKey || loadSavedKey(state.provider) || (previousProvider===state.provider ? previousKey : '');
  localStorage.setItem('codeplus-provider',state.provider);
  localStorage.setItem('codeplus-model',state.model);
  saveProviderModel(state.provider, state.model);
  localStorage.setItem('codeplus-local-url',state.localUrl);
  localStorage.removeItem('codeplus-lmstudio-url');
  state.settingsOpen=false;
  state.keyDrafts={};
  state.keyEditing={};
  state.keyRemoveConfirm='';
  if (providerInfo(state.provider).group==='Cloud' && replacementKey && replacementKey!==previousKey) { state.cloudModelsLoaded[state.provider]=false; }
  app();
}
app();
window.addEventListener('popstate', () => app());
restoreWorkspace().then(() => { if (!state.chatHistoryKey) loadChatHistory(); });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushChatHistory(); });
checkForUpdates();
setInterval(checkForUpdates, 30 * 60 * 1000);
setInterval(refreshDevStatus, 4000);
