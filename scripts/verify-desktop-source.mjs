import { access, readFile } from 'node:fs/promises';

const requiredFiles = [
  '.desktop-dist/index.html',
  '.desktop-dist/app.js',
  '.desktop-dist/styles.css',
  'src-tauri/Cargo.toml',
  'src-tauri/src/main.rs',
  'src-tauri/tauri.conf.json'
];

await Promise.all(requiredFiles.map(file => access(new URL(`../${file}`, import.meta.url))));

const packageConfig = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const tauriConfig = JSON.parse(await readFile(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'));
if (packageConfig.version !== tauriConfig.version) {
  throw new Error('package.json and Tauri versions do not match');
}
if (!tauriConfig.bundle?.createUpdaterArtifacts || !tauriConfig.plugins?.updater?.pubkey) {
  throw new Error('Signed updater artifacts are not configured');
}

console.log(`CodePlus desktop source ${tauriConfig.version} is ready to build.`);
