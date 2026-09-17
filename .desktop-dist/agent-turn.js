function cleanPath(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+/g, '/');
}

export function projectInstructionPaths(activePath = '', existingPaths = []) {
  const existing = new Set(existingPaths.map(cleanPath));
  const active = cleanPath(activePath);
  const parts = active ? active.split('/') : [];
  if (parts.length && (existing.has(active) || /\.[^/]+$/.test(parts.at(-1)))) parts.pop();
  const directories = [''];
  for (let index = 0; index < parts.length; index += 1) directories.push(parts.slice(0, index + 1).join('/'));
  return directories.flatMap(directory => {
    const prefix = directory ? `${directory}/` : '';
    const override = `${prefix}AGENTS.override.md`;
    const standard = `${prefix}AGENTS.md`;
    if (existing.has(override)) return [override];
    if (existing.has(standard)) return [standard];
    return [];
  });
}

export function projectInstructionContext(entries = []) {
  const usable = entries.filter(entry => entry?.path && String(entry.content || '').trim());
  if (!usable.length) return '';
  const body = usable.map(entry => `--- ${cleanPath(entry.path)} ---\n${String(entry.content).trim()}`).join('\n\n');
  return `Applicable project instructions are listed from broadest to most specific. Follow all of them; when they conflict, the later and more deeply scoped file wins. They remain subordinate to system safety rules and the user's latest explicit request.\n\n${body}`;
}

function frontmatterBlock(content = '') {
  const match = String(content).match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  return match?.[1] || '';
}

function frontmatterField(block = '', field = '') {
  const escaped = String(field).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = String(block).match(new RegExp(`^${escaped}\\s*:\\s*(.+)$`, 'mi'));
  return String(match?.[1] || '').trim().replace(/^['"]|['"]$/g, '');
}

export function parseSkillManifest(path = '', content = '') {
  const clean = cleanPath(path);
  if (!/(^|\/)\.agents\/skills\/[^/]+\/SKILL\.md$/i.test(clean)) return null;
  const block = frontmatterBlock(content);
  const fallbackName = clean.split('/').at(-2) || '';
  const name = frontmatterField(block, 'name') || fallbackName;
  const description = frontmatterField(block, 'description');
  if (!name || !description) return null;
  return { name, description, path: clean };
}

export function projectSkillPaths(activePath = '', existingPaths = []) {
  const active = cleanPath(activePath);
  const parts = active ? active.split('/') : [];
  if (parts.length && (/\.[^/]+$/.test(parts.at(-1)) || existingPaths.map(cleanPath).includes(active))) parts.pop();
  const scopes = new Set(['']);
  for (let index = 0; index < parts.length; index += 1) scopes.add(parts.slice(0, index + 1).join('/'));
  return existingPaths
    .map(cleanPath)
    .filter(path => {
      const match = path.match(/^(?:(.*)\/)?\.agents\/skills\/[^/]+\/SKILL\.md$/i);
      return match && scopes.has(match[1] || '');
    })
    .sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
}

export function skillCatalogContext(entries = []) {
  const manifests = entries
    .map(entry => parseSkillManifest(entry?.path, entry?.content))
    .filter(Boolean);
  if (!manifests.length) return '';
  const lines = manifests.map(skill => `- $${skill.name}: ${skill.description} (${skill.path})`).join('\n');
  return `Available project skills (metadata only):\n${lines}\n\nUse progressive disclosure: when the user explicitly names a skill or a skill clearly matches the task, read that skill's complete SKILL.md before taking action. Follow only the selected skill, and treat its scripts, references, and assets as workspace resources. Skill instructions remain subordinate to system safety and the user's latest request.`;
}

export function explicitlyRequestedSkills(prompt = '', manifests = []) {
  const requested = new Set([...String(prompt).matchAll(/\$([a-z0-9][a-z0-9._-]*)/gi)].map(match => match[1].toLowerCase()));
  return manifests.filter(skill => requested.has(String(skill?.name || '').toLowerCase()));
}

export function projectRulePaths(existingPaths = []) {
  return existingPaths
    .map(cleanPath)
    .filter(path => /^(?:\.agents|\.codex)\/rules\/[^/]+\.rules$/i.test(path))
    .sort();
}

export function parseCommandRules(entries = []) {
  const rules = [];
  for (const entry of entries) {
    const source = String(entry?.content || '');
    for (const match of source.matchAll(/prefix_rule\s*\(([\s\S]*?)\)\s*/g)) {
      const body = match[1];
      const patternBody = body.match(/pattern\s*=\s*\[([\s\S]*?)\]/)?.[1] || '';
      const pattern = [...patternBody.matchAll(/['"]([^'"]+)['"]/g)].map(item => item[1]);
      const decision = body.match(/decision\s*=\s*['"](allow|prompt|forbidden)['"]/i)?.[1]?.toLowerCase() || 'allow';
      const justification = body.match(/justification\s*=\s*['"]([^'"]*)['"]/i)?.[1] || '';
      if (pattern.length) rules.push({ pattern, decision, justification, path: cleanPath(entry.path) });
    }
  }
  return rules;
}

function commandSegments(command = '') {
  const segments = [];
  let current = '', quote = '';
  const source = String(command);
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      current += char;
      if (char === quote && source[index - 1] !== '\\') quote = '';
      continue;
    }
    if (char === '"' || char === "'") { quote = char; current += char; continue; }
    const two = source.slice(index, index + 2);
    if (char === ';' || char === '\n' || char === '|' || two === '&&' || two === '||') {
      if (current.trim()) segments.push(current.trim());
      current = '';
      if (two === '&&' || two === '||') index += 1;
      continue;
    }
    current += char;
  }
  if (current.trim()) segments.push(current.trim());
  return segments;
}

function commandTokens(segment = '') {
  return [...String(segment).matchAll(/"((?:\\.|[^"])*)"|'((?:\\.|[^'])*)'|([^\s]+)/g)]
    .map(match => match[1] ?? match[2] ?? match[3]);
}

export function commandRuleDecision(command = '', rules = []) {
  const rank = { allow: 1, prompt: 2, forbidden: 3 };
  let result = null;
  for (const tokens of commandSegments(command).map(commandTokens)) {
    for (const rule of rules) {
      if (!rule.pattern.every((part, index) => tokens[index] === part)) continue;
      if (!result || rank[rule.decision] > rank[result.decision]) result = rule;
    }
  }
  return result;
}

export function createToolAudit(originalRequest = '', { requiresMutation = false } = {}) {
  return {
    originalRequest: String(originalRequest || ''),
    requiresMutation: Boolean(requiresMutation),
    changeRevision: 0,
    explored: false,
    inspected: new Set(),
    changed: new Set(),
    appliedEdits: new Set(),
    postChangeInspected: new Set(),
    verificationRun: false,
    verificationAfterChange: false,
    reviewRequests: 0,
    actionReviewRequests: 0,
    availableSkills: [],
    commandRules: [],
    fileChanges: new Map(),
    snapshots: new Map(), preview: null, previewRevision: -1, baselinePreview: null,
    previewReviews: 0
  };
}

export function requestsMatchingWidth(request) {
  const text = String(request || '');
  return /(?:same|equal|matching?|match)\s+(?:the\s+)?width|width[\s\S]{0,60}(?:same|equal|matching?|match|အတိုင်း|တူ|ညီ)|(?:အတိုင်း|တူ|ညီ)[\s\S]{0,60}width/iu.test(text);
}

function preservesWidth(request) {
  const text = String(request || '');
  // "Make A the same width as B" explicitly authorizes a width change. Do not
  // let a nearby phrase such as "it did not work" turn that into a preserve rule.
  if (requestsMatchingWidth(text)) return false;
  const negative = '(?:do\\s+not|don[’\']t|without|must\\s+not|မပြင်|မပြောင်း|မထိ)';
  return new RegExp(`${negative}[\\s\\S]{0,80}width|width[\\s\\S]{0,80}${negative}`, 'iu').test(text);
}

export function requestContract(request) {
  if (!requestsMatchingWidth(request)) return '';
  return 'Explicit UI requirement: make the referenced elements the same width in the rendered layout while preserving the reference element width. Inspect component markup, parent wrappers, flex/grid constraints, max-width and media queries. Equal CSS width declarations do NOT prove equal rendered widths. Use inspect_preview before editing and after the last edit; fix mismatches at preview, mobile and desktop sizes. Never replace the reference width with an arbitrary fixed value just to make both declarations equal.';
}

export function toolLoopKey(audit, name, args = {}) {
  // Read/search calls are allowed again after a mutation because they observe a
  // new workspace revision. Mutation calls keep one key so repeated writes are
  // still stopped by the normal doom-loop threshold.
  const observational = name === 'read' || name === 'glob' || name === 'grep' || name === 'inspect_preview';
  const revision = observational ? Number(audit?.changeRevision || 0) : 0;
  const stable = value => {
    if (Array.isArray(value)) return value.map(stable);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  };
  return `${revision}:${name}:${JSON.stringify(stable(args || {}))}`;
}

export function widthEvidence(request, report, baseline = null) {
  if (!report || report.status !== 'measured' || !report.snapshots?.length) return { status: 'unavailable', detail: report?.error || 'No browser measurement available.' };
  const normalize = text => String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const task = normalize(request);
  const checks = [];
  let labels;
  for (const snapshot of report.snapshots) {
    const elements = snapshot.elements.filter(el => el.label && task.includes(normalize(el.label)));
    if (elements.length !== 2 || new Set(elements.map(el => normalize(el.label))).size !== 2) return { status: 'unavailable', detail: 'Cannot uniquely identify the two requested controls. Supply their exact visible labels.' };
    // Request order: target first, reference second. Ambiguous order remains in evidence.
    elements.sort((a, b) => task.indexOf(normalize(a.label)) - task.indexOf(normalize(b.label)));
    labels = elements.map(el => el.label);
    const [target, reference] = elements;
    if (![target.width, reference.width].every(n => Number.isFinite(n) && n > 0)) return { status: 'unavailable', detail: 'Controls have no measurable width.' };
    const oldReference = baseline?.snapshots?.find(item => item.viewport === snapshot.viewport)?.elements?.find(el => normalize(el.label) === normalize(reference.label));
    checks.push({ viewport: snapshot.viewport, target: target.width, reference: reference.width,
      equal: Math.abs(target.width - reference.width) <= 1,
      referencePreserved: oldReference ? Math.abs(oldReference.width - reference.width) <= 1 : null });
  }
  return { status: checks.every(c => c.equal && c.referencePreserved !== false) ? 'passed' : 'failed', labels, checks };
}

export function normalizeToolName(name) {
  const clean = String(name || '').trim().toLowerCase();
  return ({ search: 'grep', shell: 'bash', run: 'bash', list_files: 'glob' })[clean] || clean;
}

export function normalizeToolCall(call = {}) {
  let name = normalizeToolName(call.name);
  let args = call.arguments && typeof call.arguments === 'object' ? call.arguments : {};
  if (name === 'tool_call' && typeof args.name === 'string') {
    name = normalizeToolName(args.name);
    args = args.arguments && typeof args.arguments === 'object' ? args.arguments : {};
  }
  return { name, arguments: args };
}

function widthDeclarations(value) {
  return [...String(value || '').matchAll(/(?:^|[;{\s-])((?:min-|max-)?width)\s*:\s*([^;}]+)/giu)]
    .map(match => `${match[1].toLowerCase()}:${match[2].replace(/\s+/g, ' ').trim()}`);
}

export function guardToolCall(audit, name, args = {}, existingPaths = []) {
  if (!audit) return '';
  const path = cleanPath(args.filePath);
  const exists = new Set(existingPaths.map(cleanPath)).has(path);
  if ((name === 'edit' || (name === 'write' && exists)) && preservesWidth(audit.originalRequest)) {
    const before = name === 'edit' ? widthDeclarations(args.oldString) : [];
    const after = widthDeclarations(name === 'edit' ? args.newString : args.content);
    if ((name === 'write' && after.length) || JSON.stringify(before) !== JSON.stringify(after)) {
      return 'Blocked by CodePlus preserve-constraint gate: the user explicitly said not to change width. Do not modify width, min-width, or max-width; inspect the relevant route/component and satisfy the requested outcome another way.';
    }
  }
  if (name === 'edit' && (!path || !audit.inspected.has(path))) {
    return `Blocked by CodePlus quality gate: read ${path || 'the target file'} in this turn before editing it. Re-check the user's requested outcome and every preserve/do-not-change constraint.`;
  }
  if (name === 'write' && exists && !audit.inspected.has(path)) {
    return `Blocked by CodePlus quality gate: read existing file ${path} in this turn before overwriting it. Use write without a prior read only for a genuinely new file.`;
  }
  if (name === 'write' && !exists && !audit.explored) {
    return 'Blocked by CodePlus quality gate: explore the workspace with glob, grep, or read before creating a new file.';
  }
  return '';
}

export function mutationReadPrerequisite(audit, name, args = {}, existingPaths = []) {
  if (!audit) return '';
  const path = cleanPath(args.filePath);
  if (!path || audit.inspected.has(path)) return '';
  const exists = new Set(existingPaths.map(cleanPath)).has(path);
  return name === 'edit' || (name === 'write' && exists) ? path : '';
}

export function recordToolResult(audit, name, args = {}) {
  if (!audit) return;
  const path = cleanPath(args.filePath);
  if (name === 'read') {
    audit.explored = true;
    if (path) {
      audit.inspected.add(path);
      if (audit.changed.has(path)) audit.postChangeInspected.add(path);
    }
  } else if (name === 'glob' || name === 'grep') {
    audit.explored = true;
  } else if (name === 'edit' || name === 'write') {
    audit.explored = true;
    audit.changeRevision += 1;
    if (path) {
      audit.changed.add(path);
      audit.inspected.add(path);
      audit.postChangeInspected.delete(path);
    }
    audit.verificationAfterChange = false;
  } else if (name === 'bash') {
    audit.verificationRun = true;
    if (audit.changed.size) audit.verificationAfterChange = true;
  }
}

export function needsRequirementReview(audit, provider) {
  if (!audit?.changed?.size) return false;
  return [...audit.changed].some(path => !audit.postChangeInspected.has(path));
}

const SATISFIED_WITHOUT_CHANGE = /(?:already\s+(?:matches|satisfied|implemented|present|correct)|no\s+(?:code\s+)?change\s+(?:is\s+)?(?:needed|required)|requested\s+(?:state|behavior|style)\s+(?:already\s+)?(?:exists|matches)|(?:ရှိ|တူ|မှန်)(?:နေ)?ပြီး)/iu;

export function needsActionReview(audit, finalContent = '') {
  if (!audit?.requiresMutation || audit.changed.size) return false;
  // A no-change completion is valid only after the agent inspected the real
  // workspace, received an explicit action reminder, and clearly established
  // that the requested state was already present.
  return !(audit.explored && audit.actionReviewRequests > 0 && SATISFIED_WITHOUT_CHANGE.test(String(finalContent || '')));
}

export function actionReviewMessage(originalRequest, audit) {
  audit.actionReviewRequests += 1;
  return `CodePlus action gate: the user requested an actual workspace change, but no file has been changed. Do not answer with instructions, sample code, or hypothetical CSS.\n\nOriginal user request:\n${originalRequest}\n\nUse glob, grep, and read to inspect the real workspace, then use edit or write to implement the request. If the requested state is already present, inspect the exact relevant files and explain that with concrete evidence instead of proposing example code.`;
}

export function requirementReviewMessage(originalRequest, audit) {
  audit.reviewRequests += 1;
  const files = [...audit.changed].join(', ');
  const missing = [...audit.changed].filter(path => !audit.postChangeInspected.has(path)).join(', ');
  const contract = requestContract(originalRequest);
  return `CodePlus quality gate: the result is not verified yet. Do not give a final answer.\n\nOriginal user request:\n${originalRequest}${contract ? `\n\nExplicit requirement contract:\n${contract}` : ''}\n\nChanged files: ${files || '(none)'}\nFiles that must be re-read after the latest edit: ${missing || '(none)'}\nVerification command run after edits: ${audit.verificationAfterChange ? 'yes' : 'no'}\n\nRead every listed file now. Compare the actual final content against every requested outcome and preserve/do-not-change constraint, including constraints written in another language. Claims must be supported by the current tool results: never claim a route, link, file, test, or behavior that is absent from those results. A page/navigation request is not complete when only CSS changed. Fix incomplete work with tools, re-read any file changed again, and then provide a concise evidence-based summary.`;
}
