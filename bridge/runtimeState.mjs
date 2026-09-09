import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { BridgeError } from './errors.mjs';

const exec = promisify(execFile);
export function dataDirectory() {
  return process.env.OMNI_SYNC_DATA_DIR || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share'), 'OmniRouteSessionSync');
}
export async function loadState(directory = dataDirectory()) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform === 'win32') {
    // Node's POSIX mode bits do not enforce Windows ACLs. Protect before writing secrets.
    const system = process.env.SystemRoot || 'C:\\Windows';
    const { stdout } = await exec(path.join(system, 'System32', 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { windowsHide: true });
    const sid = stdout.match(/S-1-[\d-]+/)?.[0];
    if (!sid) throw new BridgeError('STATE_PERMISSIONS', 'Could not determine the current Windows user', 500);
    await exec(path.join(system, 'System32', 'icacls.exe'), [directory, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`], { windowsHide: true });
  }
  const filename = path.join(directory, 'state.json');
  let state;
  try { state = JSON.parse(await fs.readFile(filename, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw new BridgeError('STATE_INVALID', 'The bridge state file cannot be read. Restore it before starting.', 500);
    state = { version: 2, ownerToken: randomBytes(32).toString('hex'), mappings: {}, statuses: {},
      fallback: { name: 'browser-sessions', models: [], saved: false } };
  }
  if (state.version !== 2 || typeof state.ownerToken !== 'string' || state.ownerToken.length < 32)
    throw new BridgeError('STATE_INVALID', 'Unsupported bridge state file', 500);
  let writeQueue = Promise.resolve();
  const persist = (candidate = state) => {
    const snapshot = JSON.stringify(candidate, null, 2);
    writeQueue = writeQueue.catch(() => {}).then(async () => {
      const temporary = filename + '.tmp';
      await fs.writeFile(temporary, snapshot, { mode: 0o600 });
      await fs.rename(temporary, filename);
    });
    return writeQueue;
  };
  await persist();
  return { state, persist, filename };
}
