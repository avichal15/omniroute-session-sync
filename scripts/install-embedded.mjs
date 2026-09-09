import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { dataDirectory, secureDirectory } from '../bridge/runtimeState.mjs';
import { updateNodeOptions, startupVbs } from './embedded-install-lib.mjs';

const exec = promisify(execFile);
async function readOptional(filename) {
  try { return await fs.readFile(filename, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function writeAtomic(filename, value) {
  const temporary = filename + '.session-sync-' + randomUUID() + '.tmp';
  try {
    await fs.writeFile(temporary, value, { flag: 'wx', mode: 0o600 });
    await fs.rename(temporary, filename);
  } finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
}

export async function installEmbedded({ dryRun = false } = {}) {
  if (process.platform !== 'win32') throw new Error('This one-time installer currently supports Windows.');
  const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const omniInstallDir = path.resolve(process.env.OMNIROUTE_INSTALL_DIR || path.join(process.env.APPDATA, 'npm', 'node_modules', 'omniroute'));
  const pkg = JSON.parse(await fs.readFile(path.join(omniInstallDir, 'package.json'), 'utf8'));
  if (pkg.name !== 'omniroute') throw new Error('The configured installation is not OmniRoute.');
  const cliPath = path.join(omniInstallDir, 'bin', 'omniroute.mjs');
  const launcherPath = path.join(projectDir, 'scripts', 'start-integrated.mjs');
  const preload = pathToFileURL(path.join(projectDir, 'bridge', 'omniroute-preload.mjs')).href;
  await fs.access(cliPath); await fs.access(launcherPath);
  const { resolveDataDir } = await import(pathToFileURL(path.join(omniInstallDir, 'bin', 'cli', 'data-dir.mjs')).href);
  const omniDataDir = resolveDataDir();
  const envFile = path.join(omniDataDir, '.env');
  const previousEnv = await readOptional(envFile);
  const updatedEnv = updateNodeOptions(previousEnv || '', preload);
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const { stdout } = await exec(powershell, ['-NoProfile', '-NonInteractive', '-Command', '[Environment]::GetFolderPath("Startup")'], { windowsHide: true });
  const startupDir = stdout.trim();
  if (!path.isAbsolute(startupDir)) throw new Error('Could not resolve the Windows Startup folder.');
  const candidates = ['StartOmniRoute.vbs', 'OmniRoute.vbs'];
  const existing = [];
  for (const name of candidates) {
    const filename = path.join(startupDir, name);
    const content = await readOptional(filename);
    if (content !== null) existing.push({ filename, content });
  }
  if (existing.length > 1) throw new Error('Multiple OmniRoute startup scripts exist; consolidate them before setup.');
  const startupPath = existing[0]?.filename || path.join(startupDir, 'OmniRoute.vbs');
  const previousStartup = existing[0]?.content ?? null;
  if (previousStartup !== null && !/omniroute|start-integrated\.mjs/i.test(previousStartup))
    throw new Error('The existing startup file does not appear to launch OmniRoute.');
  const startupSource = startupVbs(process.execPath, launcherPath);
  const directory = dataDirectory();
  const recordFile = path.join(directory, 'installation.json');
  const priorRecord = JSON.parse(await readOptional(recordFile) || 'null');
  const record = { version: 1, projectDir, omniInstallDir, omniDataDir, envFile, cliPath,
    nodePath: process.execPath, preload, startupPath, launcherPath,
    serveArgs: priorRecord?.serveArgs || ['serve', '--no-open', ...(/--tray\b/.test(previousStartup || '') ? ['--tray'] : [])] };
  const changed = previousEnv !== updatedEnv || previousStartup !== startupSource
    || Object.entries(record).some(([key, value]) => JSON.stringify(priorRecord?.[key]) !== JSON.stringify(value));
  const summary = { success: true, changed, envFile, startupPath, preload, lifecycle: 'omniroute' };
  if (dryRun) return { ...summary, dryRun: true };
  await secureDirectory(directory);
  if (changed) {
    const backupDir = path.join(directory, 'backups', 'embedded-' + Date.now());
    await secureDirectory(backupDir);
    if (previousEnv !== null) await fs.writeFile(path.join(backupDir, 'omniroute.env'), previousEnv, { mode: 0o600 });
    if (previousStartup !== null) await fs.writeFile(path.join(backupDir, 'startup.vbs'), previousStartup, { mode: 0o600 });
    if (priorRecord) await fs.writeFile(path.join(backupDir, 'installation.json'), JSON.stringify(priorRecord, null, 2), { mode: 0o600 });
    await fs.mkdir(omniDataDir, { recursive: true });
    await fs.mkdir(startupDir, { recursive: true });
    await writeAtomic(envFile, updatedEnv);
    await writeAtomic(recordFile, JSON.stringify({ ...record, backupDir, installedAt: new Date().toISOString() }, null, 2));
    await writeAtomic(startupPath, startupSource);
    summary.backupDir = backupDir;
  }
  return summary;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  installEmbedded({ dryRun: process.argv.includes('--dry-run') }).then(result => console.log(JSON.stringify(result, null, 2)), () => {
    console.error('Embedded setup could not complete. Check the OmniRoute installation, local environment and Windows startup files.');
    process.exitCode = 1;
  });
}
