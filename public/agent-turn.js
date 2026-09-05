function cleanPath(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+/g, '/');
}

export function createToolAudit(originalRequest = '', { requiresMutation = false } = {}) {
  return {
    originalRequest: String(originalRequest || ''),
    requiresMutation: Boolean(requiresMutation),
    changeRevision: 0,
    explored: false,
    inspected: new Set(),
    changed: new Set(),
    postChangeInspected: new Set(),
    verificationRun: false,
    verificationAfterChange: false,
    reviewRequests: 0,
    actionReviewRequests: 0,
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
  return `${revision}:${name}:${JSON.stringify(args || {})}`;
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
