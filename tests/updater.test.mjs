import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { verifyUpdaterSignature } from '../scripts/verify-updater-signature.mjs';

function signedFixture(prehashed = true) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const keyId = randomBytes(8);
  const key = Buffer.concat([Buffer.from('Ed'), keyId, publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)]);
  const bytes = Buffer.from('CodePlus updater test artifact');
  const fileSignature = sign(null, prehashed ? createHash('blake2b512').update(bytes).digest() : bytes, privateKey);
  const signature = Buffer.concat([Buffer.from(prehashed ? 'ED' : 'Ed'), keyId, fileSignature]);
  const comment = 'timestamp:123 file:CodePlus.app.tar.gz';
  const global = sign(null, Buffer.concat([fileSignature, Buffer.from(comment)]), privateKey);
  return {
    bytes,
    publicKey: Buffer.from(`untrusted comment: public key\n${key.toString('base64')}\n`).toString('base64'),
    signature: Buffer.from(`untrusted comment: signature\n${signature.toString('base64')}\ntrusted comment: ${comment}\n${global.toString('base64')}\n`).toString('base64')
  };
}
for (const prehashed of [true, false]) {
  test(`signed updater verifies ${prehashed ? 'prehashed' : 'legacy'} file and rejects tampering`, () => {
    const fixture = signedFixture(prehashed);
    assert.doesNotThrow(() => verifyUpdaterSignature(fixture.bytes, fixture.signature, fixture.publicKey));
    assert.throws(() => verifyUpdaterSignature(Buffer.from('changed bytes'), fixture.signature, fixture.publicKey), /file signature/);
    assert.throws(() => verifyUpdaterSignature(fixture.bytes, fixture.signature, signedFixture().publicKey), /signing key/);
    const badComment = Buffer.from(Buffer.from(fixture.signature, 'base64').toString().replace('timestamp:123', 'timestamp:999')).toString('base64');
    assert.throws(() => verifyUpdaterSignature(fixture.bytes, badComment, fixture.publicKey), /trusted comment/);
    assert.throws(() => verifyUpdaterSignature(fixture.bytes, '', fixture.publicKey), /encoding/);
  });
}

const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
function implementation(name) {
  const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm'));
  const next = source.slice(start + 1).search(/^(?:async )?function /m);
  assert.notEqual(start, -1);
  return source.slice(start, next < 0 ? undefined : start + 1 + next);
}
function updaterFixture() {
  const calls = [];
  const state = { updateChecking: false, updateBusy: false, updateStage: 'idle' };
  const context = vm.createContext({
    state, console: { warn() {} }, window: { __TAURI_INTERNALS__: {} },
    localStorage: { setItem() {} }, app() {}, escape: value => value,
    tauriInvoke: async name => { calls.push(name); return name === 'app_version' ? '0.1.20' : { version: '0.1.21' }; },
    tauriListen: async () => () => {},
    fetch: async () => { throw new Error('Unexpected browser fetch for signed update'); },
    openExternalUrl: async () => { throw new Error('Signed update should install in the app'); }
  });
  for (const name of ['compareVersions', 'updateButton', 'checkForUpdates', 'doUpdate']) vm.runInContext(implementation(name), context);
  return { context, state, calls };
}
test('installed desktop discovers a newer signed update and shows the download icon', async () => {
  const { context, state, calls } = updaterFixture();
  await context.checkForUpdates();
  assert.deepEqual(calls, ['app_version', 'check_app_update']);
  assert.equal(state.latestVersion, '0.1.21');
  assert.equal(state.updateAvailable, true);
  assert.equal(state.updateStage, 'idle');
  assert.match(context.updateButton(), /Download and install CodePlus 0.1.21/);
});
test('clicking update installs natively, reports progress, and retains restarting state', async () => {
  const { context, state } = updaterFixture();
  let handler, cleanups = 0, installs = 0;
  state.latestVersion = '0.1.21';
  context.tauriListen = async (event, callback) => {
    assert.equal(event, 'app-update-progress');
    handler = callback;
    return () => { cleanups++; };
  };
  context.tauriInvoke = async command => {
    assert.equal(command, 'install_app_update');
    installs++;
    handler({ payload: { stage: 'downloading', downloaded: 50, total: 100 } });
    assert.equal(state.updateProgress, 50);
    handler({ payload: { stage: 'installing' } });
    handler({ payload: { stage: 'restarting' } });
  };
  await context.doUpdate();
  assert.equal(installs, 1);
  assert.equal(cleanups, 1);
  assert.equal(state.updateBusy, true);
  assert.equal(state.updateStage, 'restarting');
});
test('failed native update preserves an actionable error and allows retry', async () => {
  const { context, state } = updaterFixture();
  context.tauriInvoke = async () => { throw 'Signature verification failed'; };
  await context.doUpdate();
  assert.equal(state.updateBusy, false);
  assert.match(state.vscodeNote, /Signature verification failed/);
});
