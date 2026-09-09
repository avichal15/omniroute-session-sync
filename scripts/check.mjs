import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let checked = 0;
for (const directory of ['bridge', 'extension', 'scripts', 'tests']) {
  for (const name of fs.readdirSync(path.join(root, directory), { recursive: true })) {
    if (!/\.(?:mjs|js)$/.test(name)) continue;
    const result = spawnSync(process.execPath, ['--check', path.join(root, directory, name)], { stdio: 'inherit', windowsHide: true });
    if (result.status !== 0) process.exit(result.status || 1);
    checked++;
  }
}
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'extension/manifest.json'), 'utf8'));
for (const file of [manifest.background.service_worker, manifest.action.default_popup, ...Object.values(manifest.icons)])
  if (!fs.existsSync(path.join(root, 'extension', file))) throw new Error(`Missing extension asset: ${file}`);
console.log(`Syntax checked ${checked} JavaScript files; extension assets exist.`);
