// Tests are isolated fixtures. This entry point never imports a live database updater.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const directory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../tests');
const files = fs.readdirSync(directory).filter(name => name.endsWith('.test.mjs')).map(name => path.join(directory, name));
const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit', windowsHide: true });
process.exitCode = result.status ?? 1;
