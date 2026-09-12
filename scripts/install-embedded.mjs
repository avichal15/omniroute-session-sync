import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { dataDirectory, secureDirectory } from '../bridge/runtimeState.mjs';
import { removeNodeOptions, startupVbs } from './embedded-install-lib.mjs';

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

export async function installEmbedded({ dryRun = false, migrateFrom } = {}) {
  if (process.platform !== 'win32') throw new Error('This one-time installer currently supports Windows.');
  const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const omniInstallDir = path.resolve(process.env.OMNIROUTE_INSTALL_DIR || path.join(process.env.APPDATA, 'npm', 'node_modules', 'omniroute'));
  const pkg = JSON.parse(await fs.readFile(path.join(omniInstallDir, 'package.json'), 'utf8'));
  if (pkg.name !== 'omniroute') throw new Error('The configured installation is not OmniRoute.');
  const cliPath = path.join(omniInstallDir, 'bin', 'omniroute.mjs');
  const bridgePath = path.join(projectDir, 'bridge', 'server.mjs');
  const launcherPath = path.join(projectDir, 'scripts', 'start-integrated.mjs');
  const preload = pathToFileURL(path.join(projectDir, 'bridge', 'omniroute-preload.mjs')).href;
  await fs.access(cliPath); await fs.access(bridgePath); await fs.access(launcherPath);
  const { resolveDataDir } = await import(pathToFileURL(path.join(omniInstallDir, 'bin', 'cli', 'data-dir.mjs')).href);
  const omniDataDir = resolveDataDir();
  const envFile = path.join(omniDataDir, '.env');
  const previousEnv = await readOptional(envFile);
  const updatedEnv = removeNodeOptions(previousEnv || '', preload);
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
  const legacyStartup = existing[0];
  if (legacyStartup && !/omniroute|start-integrated\.mjs/i.test(legacyStartup.content))
    throw new Error('The existing startup file does not appear to launch OmniRoute.');
  const directory = dataDirectory();
  const legacyDirectory = migrateFrom || path.join(process.env.LOCALAPPDATA, 'OmniRouteSessionSync');
  if (!path.isAbsolute(legacyDirectory)) throw new Error('The migration source must be an absolute directory.');
  const stateFile = path.join(directory, 'state.json');
  const oldState = path.resolve(legacyDirectory) !== path.resolve(directory) && await readOptional(stateFile) === null
    ? await readOptional(path.join(legacyDirectory, 'state.json')) : null;
  if (oldState !== null) {
    const parsed = JSON.parse(oldState);
    if (parsed.version !== 2 || typeof parsed.ownerToken !== 'string' || parsed.ownerToken.length < 32)
      throw new Error('The previous sync state is invalid; it has been preserved.');
  }
  const startupPath = path.join(directory, 'start-integrated.vbs');
  const previousStartup = await readOptional(startupPath);
  const startupSource = startupVbs(process.execPath, launcherPath, { directory, configPath: path.join(projectDir, 'bridge', 'config.json') });
  const startupTaskName = 'OmniRoute Session Sync';
  const taskScript = path.join(projectDir, 'scripts', 'register-autostart.ps1');
  const taskCommand = mode => exec(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', taskScript, '-Mode', mode, '-LauncherPath', startupPath, '-TaskName', startupTaskName], { windowsHide: true });
  const task = JSON.parse((await taskCommand('Inspect')).stdout);
  if (!task.owned) throw new Error('An unrelated Windows task already uses the startup task name.');
  const recordFile = path.join(directory, 'installation.json');
  const priorRecord = JSON.parse(await readOptional(recordFile)
    || (path.resolve(legacyDirectory) !== path.resolve(directory) ? await readOptional(path.join(legacyDirectory, 'installation.json')) : null) || 'null');
  const record = { version: 1, projectDir, omniInstallDir, omniDataDir, envFile, cliPath, bridgePath,
    nodePath: process.execPath, preload, startupPath, launcherPath, lifecycle: 'supervised-sidecar',
    startupType: 'scheduled-task', startupTaskName,
    previousStartupPath: priorRecord?.previousStartupPath || legacyStartup?.filename || null,
    serveArgs: priorRecord?.serveArgs || ['serve', '--no-open', ...(/--tray\b/.test(legacyStartup?.content || '') ? ['--tray'] : [])] };
  const changed = oldState !== null || previousEnv !== updatedEnv || previousStartup !== startupSource || Boolean(legacyStartup) || !task.matches
    || Object.entries(record).some(([key, value]) => JSON.stringify(priorRecord?.[key]) !== JSON.stringify(value));
  const summary = { success: true, changed, envFile, stateDirectory: directory, startupPath, startupTaskName,
    importsSavedPairing: oldState !== null, lifecycle: 'supervised-sidecar' };
  if (dryRun) return { ...summary, dryRun: true };
  await secureDirectory(directory);
  if (changed) {
    const backupDir = path.join(directory, 'backups', 'embedded-' + Date.now());
    await secureDirectory(backupDir);
    if (previousEnv !== null) await fs.writeFile(path.join(backupDir, 'omniroute.env'), previousEnv, { mode: 0o600 });
    if (previousStartup !== null) await fs.writeFile(path.join(backupDir, 'startup.vbs'), previousStartup, { mode: 0o600 });
    if (legacyStartup) await fs.writeFile(path.join(backupDir, 'legacy-startup.vbs'), legacyStartup.content, { mode: 0o600 });
    if (priorRecord) await fs.writeFile(path.join(backupDir, 'installation.json'), JSON.stringify(priorRecord, null, 2), { mode: 0o600 });
    // Copy the observed paired state exactly once; never replace a target state
    // created concurrently or reset its tokens. Keep the source as a backup.
    if (oldState !== null) await fs.writeFile(stateFile, oldState, { flag: 'wx', mode: 0o600 });
    await fs.mkdir(omniDataDir, { recursive: true });
    await writeAtomic(envFile, updatedEnv);
    await writeAtomic(startupPath, startupSource);
    await taskCommand('Install');
    await writeAtomic(recordFile, JSON.stringify({ ...record, backupDir, installedAt: new Date().toISOString() }, null, 2));
    // Remove only the inspected legacy entry, after the replacement is registered.
    if (legacyStartup) {
      if (path.dirname(path.resolve(legacyStartup.filename)) !== path.resolve(startupDir)
        || await readOptional(legacyStartup.filename) !== legacyStartup.content)
        throw new Error('The legacy startup entry changed during installation; it was preserved.');
      await fs.unlink(legacyStartup.filename);
    }
    summary.backupDir = backupDir;
  }
  return summary;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const migrateIndex = process.argv.indexOf('--migrate-from');
  installEmbedded({ dryRun: process.argv.includes('--dry-run'), migrateFrom: migrateIndex < 0 ? undefined : process.argv[migrateIndex + 1] })
    .then(result => console.log(JSON.stringify(result, null, 2)), () => {
    console.error('Embedded setup could not complete. Check the OmniRoute installation, local environment and Windows startup files.');
    process.exitCode = 1;
  });
}
