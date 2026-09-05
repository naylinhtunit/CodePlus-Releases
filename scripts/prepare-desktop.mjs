import { cp, mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const source = path.join(projectRoot, 'public');
const target = path.join(projectRoot, '.desktop-dist');

await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });

for (const entry of await readdir(source, { withFileTypes: true })) {
  // Installer downloads belong to the web landing page. Bundling them inside
  // desktop apps recursively inflates every subsequent DMG/EXE build.
  if (entry.name === 'downloads') continue;
  await cp(path.join(source, entry.name), path.join(target, entry.name), { recursive: true });
}

console.log('Prepared desktop frontend without landing-page installers.');
