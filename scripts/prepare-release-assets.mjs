import { copyFile, mkdir, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const [input = 'artifacts', output = 'release-assets'] = process.argv.slice(2);
const inputRoot = resolve(input);
const outputRoot = resolve(output);
await mkdir(outputRoot, { recursive: true });

async function filesBelow(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await filesBelow(file));
    else if (entry.isFile()) result.push(file);
  }
  return result;
}

const bundles = [
  ['CodePlus-macos-arm64', '.dmg', 'CodePlus-macOS-arm64.dmg'],
  ['CodePlus-macos-arm64', '.app.tar.gz', 'CodePlus-macOS-arm64.app.tar.gz'],
  ['CodePlus-macos-arm64', '.app.tar.gz.sig', 'CodePlus-macOS-arm64.app.tar.gz.sig'],
  ['CodePlus-macos-x64', '.dmg', 'CodePlus-macOS-x64.dmg'],
  ['CodePlus-macos-x64', '.app.tar.gz', 'CodePlus-macOS-x64.app.tar.gz'],
  ['CodePlus-macos-x64', '.app.tar.gz.sig', 'CodePlus-macOS-x64.app.tar.gz.sig'],
  ['CodePlus-windows-x64', '-setup.exe', 'CodePlus-windows-x64-setup.exe'],
  ['CodePlus-windows-x64', '-setup.exe.sig', 'CodePlus-windows-x64-setup.exe.sig'],
  ['CodePlus-windows-x64', '.msi', 'CodePlus-windows-x64.msi']
];
for (const [artifact, suffix, name] of bundles) {
  const matches = (await filesBelow(join(inputRoot, artifact))).filter(file => file.endsWith(suffix));
  if (matches.length !== 1) throw new Error(`Expected one ${suffix} in ${artifact}, found ${matches.length}`);
  await copyFile(matches[0], join(outputRoot, name));
}
console.log(`Prepared ${bundles.length} installer and signed update files`);
