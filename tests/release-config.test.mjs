import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

test('private source repository excludes desktop release output and workflow', () => {
  const config = JSON.parse(readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'));
  assert.notEqual(config.bundle?.macOS?.signingIdentity, '-');
  assert.equal(existsSync(new URL('../.github/workflows/desktop-installers.yml', import.meta.url)), false);
  const gitignore = readFileSync(new URL('../.gitignore', import.meta.url), 'utf8');
  for (const pattern of [
    'src-tauri/target/',
    'public/downloads/CodePlus-macOS-*.dmg',
    'public/downloads/CodePlus-windows-*.exe',
    'public/downloads/CodePlus-windows-*.msi'
  ]) {
    assert.match(gitignore, new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
  }
});
