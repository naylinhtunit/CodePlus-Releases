import test from 'node:test';
import assert from 'node:assert/strict';
import { createToolAudit, guardToolCall, mutationReadPrerequisite, recordToolResult, needsRequirementReview, requirementReviewMessage, requestContract, toolLoopKey, normalizeToolName, normalizeToolCall, needsActionReview, actionReviewMessage } from '../public/agent-turn.js';

test('agent quality gate requires a current-turn read before existing-file mutations', () => {
  const audit = createToolAudit();
  const paths = ['src/app/page.tsx', 'src/app/globals.css'];
  assert.match(guardToolCall(audit, 'edit', { filePath: 'src/app/globals.css' }, paths), /read .* before editing/i);
  assert.match(guardToolCall(audit, 'write', { filePath: 'src/app/page.tsx' }, paths), /before overwriting/i);
  assert.equal(mutationReadPrerequisite(audit, 'write', { filePath: 'src/app/page.tsx' }, paths), 'src/app/page.tsx');
  recordToolResult(audit, 'read', { filePath: 'src/app/globals.css' });
  assert.equal(guardToolCall(audit, 'edit', { filePath: 'src/app/globals.css' }, paths), '');
  assert.equal(mutationReadPrerequisite(audit, 'edit', { filePath: 'src/app/globals.css' }, paths), '');
});

test('new files require exploration and local changes require one requirement review', () => {
  const audit = createToolAudit();
  assert.match(guardToolCall(audit, 'write', { filePath: 'src/app/docs/page.tsx' }, ['src/app/page.tsx']), /explore/i);
  recordToolResult(audit, 'glob', { pattern: 'src/**/*' });
  assert.equal(guardToolCall(audit, 'write', { filePath: 'src/app/docs/page.tsx' }, ['src/app/page.tsx']), '');
  recordToolResult(audit, 'write', { filePath: 'src/app/docs/page.tsx' });
  assert.equal(needsRequirementReview(audit, 'local'), true);
  assert.equal(needsRequirementReview(audit, 'openai'), true);
  const review = requirementReviewMessage('Create a docs page; do not change button width.', audit);
  assert.match(review, /do not change button width/);
  assert.match(review, /src\/app\/docs\/page\.tsx/);
  assert.equal(needsRequirementReview(audit, 'local'), true);
  recordToolResult(audit, 'read', { filePath: 'src/app/docs/page.tsx' });
  assert.equal(needsRequirementReview(audit, 'local'), false);
  assert.equal(needsRequirementReview(audit, 'openai'), false);
});

test('preserve constraint blocks width mutations and edits require a fresh post-change read', () => {
  const audit = createToolAudit('Fix the docs navigation, but do not change button width.');
  recordToolResult(audit, 'read', { filePath: 'src/app/globals.css' });
  assert.match(guardToolCall(audit, 'edit', {
    filePath: 'src/app/globals.css', oldString: '.secondary { width: auto; }', newString: '.secondary { width: 100%; }'
  }, ['src/app/globals.css']), /preserve-constraint/i);
  assert.equal(guardToolCall(audit, 'edit', {
    filePath: 'src/app/globals.css', oldString: '.secondary { width: auto; color: red; }', newString: '.secondary { width: auto; color: blue; }'
  }, ['src/app/globals.css']), '');
  assert.equal(guardToolCall(audit, 'edit', {
    filePath: 'src/app/globals.css', oldString: 'color: red', newString: 'color: blue'
  }, ['src/app/globals.css']), '');
  recordToolResult(audit, 'edit', { filePath: 'src/app/globals.css' });
  assert.equal(needsRequirementReview(audit, 'local'), true);
  recordToolResult(audit, 'read', { filePath: 'src/app/globals.css' });
  assert.equal(needsRequirementReview(audit, 'local'), false);
});

test('same-width requests are positive requirements, not preserve constraints', () => {
  const request = 'View docs button width ကို Start building width အတိုင်းထားပေးပါ။ အရင်က မလုပ်ပေးဘူး။';
  const audit = createToolAudit(request);
  recordToolResult(audit, 'read', { filePath: 'src/app/globals.css' });
  assert.match(requestContract(request), /same width/i);
  assert.equal(guardToolCall(audit, 'edit', {
    filePath: 'src/app/globals.css', oldString: '.secondary { width: auto; }', newString: '.secondary { width: 100%; }'
  }, ['src/app/globals.css']), '');
});

test('loop keys allow post-edit verification reads while repeated mutations remain bounded', () => {
  const audit = createToolAudit('Update the page');
  const read = { filePath: 'src/app/page.tsx' };
  const edit = { filePath: 'src/app/page.tsx', oldString: 'a', newString: 'b' };
  const before = toolLoopKey(audit, 'read', read);
  const editKey = toolLoopKey(audit, 'edit', edit);
  recordToolResult(audit, 'read', read);
  recordToolResult(audit, 'edit', edit);
  assert.notEqual(toolLoopKey(audit, 'read', read), before);
  assert.equal(toolLoopKey(audit, 'edit', edit), editKey);
  recordToolResult(audit, 'read', read);
  assert.equal(needsRequirementReview(audit, 'local'), false);
});

test('common local-model tool synonyms normalize to CodePlus tools', () => {
  assert.equal(normalizeToolName('search'), 'grep');
  assert.equal(normalizeToolName('shell'), 'bash');
  assert.equal(normalizeToolName('run'), 'bash');
  assert.equal(normalizeToolName('list_files'), 'glob');
  assert.equal(normalizeToolName('EDIT'), 'edit');
});

test('generic local-model tool_call wrappers unwrap to the requested tool', () => {
  assert.deepEqual(normalizeToolCall({ name: 'tool_call', arguments: { name: 'edit', arguments: { filePath: 'a.css', oldString: 'a', newString: 'b' } } }), {
    name: 'edit', arguments: { filePath: 'a.css', oldString: 'a', newString: 'b' }
  });
});

test('action gate rejects tutorial answers until a requested workspace change is grounded', () => {
  const audit = createToolAudit('Set the button width', { requiresMutation: true });
  assert.equal(needsActionReview(audit), true);
  assert.match(actionReviewMessage(audit.originalRequest, audit), /Do not answer with instructions, sample code/i);
  assert.equal(needsActionReview(audit), true, 'a second ungrounded final answer must still be rejected');
  actionReviewMessage(audit.originalRequest, audit);
  assert.equal(audit.actionReviewRequests, 2);

  const inspected = createToolAudit('Set the button width', { requiresMutation: true });
  recordToolResult(inspected, 'read', { filePath: 'src/app/globals.css' });
  assert.equal(needsActionReview(inspected, 'Use this sample CSS.'), true, 'inspection alone gets one explicit action reminder');
  actionReviewMessage(inspected.originalRequest, inspected);
  assert.equal(needsActionReview(inspected, 'Use this sample CSS.'), true, 'generic advice remains blocked after inspection');
  assert.equal(needsActionReview(inspected, 'No code change is needed because the buttons already match.'), false, 'an already-satisfied state may be reported after grounded inspection');
  recordToolResult(inspected, 'edit', { filePath: 'src/app/globals.css' });
  assert.equal(needsActionReview(inspected), false);
});
