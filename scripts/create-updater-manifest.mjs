import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { verifyUpdaterSignature } from './verify-updater-signature.mjs';

const [versionInput, assetsInput = 'release-assets', repository = 'naylinhtunit/CodePlus-Releases'] = process.argv.slice(2);
if (!versionInput) throw new Error('Usage: node scripts/create-updater-manifest.mjs <version> [assets-directory] [repository]');

const version = versionInput.replace(/^v/, '');
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('A stable semantic version is required');
const config = JSON.parse(await readFile(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'));
if (config.version !== version) throw new Error('Release version does not match app configuration');
const tag = `v${version}`;
const assetsDirectory = resolve(assetsInput);
const assetBase = `https://github.com/${repository}/releases/download/${tag}`;

async function signature(assetName) {
  const signed = (await readFile(resolve(assetsDirectory, `${assetName}.sig`), 'utf8')).trim();
  verifyUpdaterSignature(await readFile(resolve(assetsDirectory, assetName)), signed, config.plugins.updater.pubkey);
  return signed;
}

const assets = {
  macArm: 'CodePlus-macOS-arm64.app.tar.gz',
  macIntel: 'CodePlus-macOS-x64.app.tar.gz',
  windows: 'CodePlus-windows-x64-setup.exe'
};

const manifest = {
  version,
  notes: `CodePlus ${tag} desktop update.`,
  pub_date: new Date().toISOString(),
  platforms: {
    'darwin-aarch64': {
      url: `${assetBase}/${assets.macArm}`,
      signature: await signature(assets.macArm)
    },
    'darwin-x86_64': {
      url: `${assetBase}/${assets.macIntel}`,
      signature: await signature(assets.macIntel)
    },
    'windows-x86_64': {
      url: `${assetBase}/${assets.windows}`,
      signature: await signature(assets.windows)
    }
  }
};

await writeFile(resolve(assetsDirectory, 'latest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
