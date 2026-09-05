import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Publish a tracked source snapshot, never private Git history or local secrets.
const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
const destination = process.argv[2];
if (!destination) throw new Error('Usage: node scripts/sync-release-source.mjs <CodePlus-Releases-checkout>');
const target = resolve(destination);
const git = (...args) => execFileSync('git', args, { cwd: sourceRoot, maxBuffer: 64 * 1024 * 1024 });
const remote = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: target, encoding: 'utf8' }).trim();
if (!/github\.com[:/]naylinhtunit\/CodePlus-Releases(?:\.git)?$/.test(remote)) throw new Error('Destination must be CodePlus-Releases');
if (execFileSync('git', ['status', '--porcelain'], { cwd: target, encoding: 'utf8' }).trim()) throw new Error('Destination has uncommitted changes');
if (git('status', '--porcelain').toString().trim()) throw new Error('Commit source changes before publishing a snapshot');
const roots = new Set(['.gitignore', '.env.example', 'README.md', 'package.json', 'package-lock.json', 'server.mjs', 'vercel.json', 'public', 'src-tauri', 'scripts', 'tests', 'api']);
const files = git('ls-tree', '-r', '--name-only', '-z', 'HEAD').toString().split('\0').filter(file => file && roots.has(file.split('/')[0]) && !file.endsWith('.DS_Store') && !/\.(?:dmg|exe|msi|key|p12|pem)$/.test(file));
const contents = files.map(file => [file, git('show', `HEAD:${file}`)]);
for (const [file, bytes] of contents) {
  if (/\.(?:png|ico|icns|webp|zip)$/.test(file)) continue;
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|(?:ghp_|github_pat_|sk-proj-)[A-Za-z0-9_]{20,}/.test(bytes.toString())) throw new Error(`Possible credential in ${file}; publication stopped`);
}
for (const [file, bytes] of contents) {
  await mkdir(dirname(resolve(target, file)), { recursive: true });
  await writeFile(resolve(target, file), bytes);
}
await writeFile(resolve(target, 'SOURCE_VERSION.json'), JSON.stringify({ version: JSON.parse(git('show', 'HEAD:package.json')).version, sourceCommit: git('rev-parse', 'HEAD').toString().trim() }, null, 2) + '\n');
console.log(`Copied ${files.length} tracked source files. Review and commit the public snapshot before dispatching its release workflow.`);
