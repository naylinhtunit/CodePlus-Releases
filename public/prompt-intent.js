const CASUAL_PHRASES = new Set([
  'hi', 'hello', 'hey', 'hiya', 'yo', 'good morning', 'good afternoon', 'good evening',
  'thanks', 'thank you', 'ok', 'okay', 'got it', 'how are you',
  'ဟလို', 'မင်္ဂလာပါ', 'နေကောင်းလား', 'ကျေးဇူး', 'ကျေးဇူးတင်ပါတယ်', 'အိုကေ',
  'こんにちは', 'こんばんは', 'おはよう', 'ありがとう', '你好', '您好', '谢谢'
]);

function normalizedPrompt(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const WORKSPACE_ARTIFACT = /(?:\b(?:code|file|folder|project|repo(?:sitory)?|workspace|component|function|class|button|page|route|link|css|html|tsx?|jsx?|json|readme|api|test|build|bug|error|terminal|command|preview|app|layout|style|docs?|package|dependenc(?:y|ies))\b|[\w.-]+\/(?:[\w.-]+\/)*[\w.-]+|\.[cm]?[jt]sx?\b|\.css\b|\.html?\b|\.json\b|\.md\b|ဖိုင်|ကုဒ်|ပရောဂျက်|စာမျက်နှာ|ခလုတ်|လင့်ခ်|အက်ပ်)/iu;
const WORKSPACE_ACTION = /(?:\b(?:add|apply|build|change|check|connect|create|debug|delete|edit|fix|implement|inspect|make|modify|move|open|read|refactor|remove|rename|replace|resize|run|set|style|test|update|verify|wire|write)\b|ပြင်|ပြောင်း|ထည့်|ဖျက်|ရေး|လုပ်|စစ်|ဖန်တီး|တည်ဆောက်|ဖွင့်|ရွှေ့|ထား|ညှိ)/iu;
const CONTEXT_REFERENCE = /(?:\b(?:this|that|it|current|above|previous)\b|ဒီဟာ|ဒါကို|အခုဟာ|အပေါ်က)/iu;
const GENERAL_QUESTION = /^(?:what|who|when|where|which|how|why|explain|define|tell me|translate|summarize)\b/iu;
const NO_MUTATION = /(?:\b(?:do\s+not|don[’']t|without)\s+(?:change|edit|modify|write|update)\b|မပြင်|မပြောင်း|မရေး)/iu;

export function promptNeedsTools(prompt, { hasAttachments = false, previousMode = '' } = {}) {
  if (hasAttachments) return true;
  const text = normalizedPrompt(prompt);
  if (!text || CASUAL_PHRASES.has(text)) return false;
  if (WORKSPACE_ARTIFACT.test(text) && WORKSPACE_ACTION.test(text)) return true;
  if (WORKSPACE_ACTION.test(text) && CONTEXT_REFERENCE.test(text) && previousMode === 'agent') return true;
  if (GENERAL_QUESTION.test(text) && !CONTEXT_REFERENCE.test(text) && !WORKSPACE_ACTION.test(text)) return false;
  // A coding workspace behaves like Codex: tools are available by default.
  // Only confidently casual/general conversation is routed to tool-free chat.
  return true;
}

export function promptRequestsMutation(prompt) {
  const text = normalizedPrompt(prompt);
  if (!text || NO_MUTATION.test(text)) return false;
  return WORKSPACE_ACTION.test(text) && (WORKSPACE_ARTIFACT.test(text) || CONTEXT_REFERENCE.test(text));
}

export function casualHistory(messages, limit = 10) {
  return (Array.isArray(messages) ? messages : [])
    .filter(message => message?.mode === 'chat' && !message.error && !message.stopped && !message.tool_calls?.length && message.role !== 'tool' && String(message.content || '').trim())
    .slice(-limit)
    .map(message => ({ role: message.role === 'assistant' ? 'assistant' : 'user', content: String(message.content) }));
}
