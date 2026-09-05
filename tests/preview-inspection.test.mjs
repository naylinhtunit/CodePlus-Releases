import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { inspectPreview, validatePreviewRequest } from '../scripts/inspect-preview.mjs';
import { widthEvidence } from '../public/agent-turn.js';

const request = 'Set "View docs" to the same width as "Start building"';
const report = (mobile = 304, reference = 304) => ({ status: 'measured', snapshots: [
  { viewport: 400, elements: [{ label: 'View docs', width: mobile }, { label: 'Start building', width: reference }] },
  { viewport: 1280, elements: [{ label: 'View docs', width: 168 }, { label: 'Start building', width: 168 }] }
] });
test('browser evidence rejects mobile mismatch, changed reference, missing and ambiguous controls', () => {
  assert.equal(widthEvidence(request, report(168)).status, 'failed');
  assert.equal(widthEvidence(request, report()).status, 'passed');
  assert.equal(widthEvidence(request, report(168, 168), report()).status, 'failed');
  assert.equal(widthEvidence(request, { status: 'unavailable', error: 'No browser' }).status, 'unavailable');
  assert.equal(widthEvidence('unrelated task', report()).status, 'unavailable');
  const duplicate = report(); duplicate.snapshots[0].elements.push({ label: 'View docs', width: 304 });
  assert.equal(widthEvidence(request, duplicate).status, 'unavailable');
});
test('preview URL validation rejects nonlocal hosts, file URLs, credentials and low ports', () => {
  for (const url of ['file:///etc/passwd', 'https://example.com', 'http://127.0.0.1:80', 'http://user@localhost:3000', 'http://localhost.example.com:3000', 'http://192.168.1.1:3000']) {
    assert.throws(() => validatePreviewRequest({ url }));
  }
  assert.equal(validatePreviewRequest({ url: 'http://localhost:3000', width: 400 }).width, 400);
});

test('real browser reproduces responsive wrapper bug and validates only a correct repair', { skip: !process.env.CODEPLUS_BROWSER_TEST }, async () => {
  let repaired = false;
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end(`<!doctype html><style>
      .actions { display:flex; flex-wrap:wrap; gap:12px }
      button { width:168px;height:40px }
      a { display:inline-flex;width:100%;max-width:168px }
      a button { width:100%;max-width:168px }
      @media(max-width:520px) { .actions {width:304px} button {flex:1 1 100%} }
      ${repaired ? '@media(max-width:520px){ .actions a {flex:1 1 100%;max-width:none} .actions a button {max-width:none} }' : ''}
      </style><div class="actions"><button>Start building</button><a href="/docs"><button>View docs</button></a></div>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const input = { url: `http://127.0.0.1:${server.address().port}`, width: 400 };
    const before = await inspectPreview(input);
    assert.equal(widthEvidence(request, before).status, 'failed');
    assert.equal(before.snapshots[0].elements[0].width, 304);
    assert.equal(before.snapshots[0].elements[1].width, 168);
    repaired = true;
    const after = await inspectPreview(input);
    assert.equal(widthEvidence(request, after, before).status, 'passed');
  } finally { await new Promise(resolve => server.close(resolve)); }
});
