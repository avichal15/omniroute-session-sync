import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { dataDirectory, secureDirectory } from '../bridge/runtimeState.mjs';
import { loopbackUrl } from '../bridge/omniClient.mjs';
import { addPreload, readNodeOptions } from './embedded-install-lib.mjs';

const exec = promisify(execFile);
const STARTUP_CODES = ['ERR_MODULE_NOT_FOUND', 'ERR_REQUIRE_ESM', 'ERR_UNSUPPORTED_ESM_URL_SCHEME',
  'ERR_DLOPEN_FAILED', 'ERR_UNKNOWN_FILE_EXTENSION', 'ERR_INVALID_ARG_TYPE', 'ERR_WORKER_OUT_OF_MEMORY',
  'EADDRINUSE', 'EACCES', 'ENOENT', 'EBADF', 'ENOMEM'];

export async function readInstallation(directory = dataDirectory()) {
  const record = JSON.parse(await fs.readFile(path.join(directory, 'installation.json'), 'utf8'));
  if (record.version !== 1 || ![record.nodePath, record.cliPath, record.projectDir, record.envFile, record.omniInstallDir]
    .every(value => typeof value === 'string' && path.isAbsolute(value))
    || !Array.isArray(record.serveArgs) || record.serveArgs.some(value => typeof value !== 'string' || /[\0\r\n]/.test(value)))
    throw new Error('Run the one-time embedded setup before launching.');
  const configPath = path.join(record.projectDir, 'bridge', 'config.json');
  const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
  const gateway = new URL(loopbackUrl(config.omnirouteBaseUrl));
  const sync = new URL(loopbackUrl(`http://${config.host}:${config.port}`));
  return { record, configPath, directory: path.resolve(directory), gateway, sync };
}

function instanceAddress(directory) {
  const identity = path.resolve(directory);
  const hash = createHash('sha256').update(process.platform === 'win32' ? identity.toLowerCase() : identity).digest('hex').slice(0, 24);
  return process.platform === 'win32' ? `\\\\.\\pipe\\omniroute-session-sync-${hash}` : path.join(directory, 'supervisor.sock');
}
function connected(options) {
  return new Promise(resolve => {
    const socket = net.createConnection(options);
    const finish = value => { socket.destroy(); resolve(value); };
    socket.setTimeout(1000, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}
export function supervisorRunning(directory) { return connected(instanceAddress(directory)); }
async function acquireInstance(directory) {
  const address = instanceAddress(directory);
  // Unix leaves socket files behind after a crash; Windows releases named pipes.
  if (process.platform !== 'win32' && !await supervisorRunning(directory)) await fs.rm(address, { force: true });
  const server = net.createServer(socket => socket.destroy());
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(address, resolve); });
    return () => new Promise(resolve => server.close(resolve));
  } catch (error) { if (error.code === 'EADDRINUSE') return null; throw error; }
}

async function probe(url, timeoutMs) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
    const reader = response.body.getReader(); let size = 0; const chunks = [];
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length;
      if (size > 65536) { await reader.cancel(); return { status: response.status }; }
      chunks.push(Buffer.from(value));
    }
    let body; try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch {}
    return { status: response.status, body };
  } catch { return { status: null }; }
}
export async function integratedHealth(context, timeoutMs = 3000) {
  const [gateway, sync] = await Promise.all([
    probe(new URL('/api/monitoring/health', context.gateway), timeoutMs),
    probe(new URL('/health', context.sync), timeoutMs),
  ]);
  return { ready: gateway.status === 200 && sync.status === 200 && sync.body?.ready === true
      && sync.body?.service === 'omniroute-session-sync' && sync.body?.runtime?.lifecycle === 'omniroute',
    gatewayHttp: gateway.status, syncHttp: sync.status,
    syncProcessId: sync.body?.runtime?.processId };
}

function diagnostics(directory) {
  let queue = Promise.resolve();
  return value => {
    queue = queue.catch(() => {}).then(async () => {
      const filename = path.join(directory, 'startup.log');
      const info = await fs.stat(filename).catch(() => null);
      if (info?.size > 262144) {
        await fs.rm(filename + '.1', { force: true });
        await fs.rename(filename, filename + '.1');
      }
      await fs.appendFile(filename, JSON.stringify({ at: new Date().toISOString(), ...value }) + '\n', { mode: 0o600 });
    });
    // Diagnostic I/O must not terminate a healthy gateway.
    return queue.catch(() => {});
  };
}
async function saveStatus(directory, status) {
  const filename = path.join(directory, 'startup-status.json');
  await fs.writeFile(filename + '.tmp', JSON.stringify(status, null, 2), { mode: 0o600 });
  for (let attempt = 0; ; attempt++) {
    try { await fs.rename(filename + '.tmp', filename); return; }
    catch (error) {
      // A concurrent Windows reader or scanner can briefly hold the destination.
      if (attempt >= 9 || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
      await delay(50);
    }
  }
}
async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    const taskkill = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
    await exec(taskkill, ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }).catch(() => {});
  } else child.kill('SIGTERM');
  if (child.exitCode === null && child.signalCode === null)
    await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(5000, undefined, { ref: false })]);
}

export async function runSupervisor({ directory = dataDirectory(), signal, pollMs = 10000, retryMs = 10000 } = {}) {
  const context = await readInstallation(directory);
  await secureDirectory(context.directory);
  const release = await acquireInstance(context.directory);
  if (!release) return { success: true, alreadyRunning: true };
  const log = diagnostics(context.directory);
  let child, exited, retryAt = 0, failures = 0, phase, startedAt;
  const errorCodes = new Set();
  try {
    await log({ event: 'supervisor-started', processId: process.pid });
    while (!signal?.aborted) {
      if (exited) {
        await log({ event: 'gateway-exited', childPid: child?.pid, code: exited.code, signal: exited.signal });
        if (Date.now() - startedAt > 60000) failures = 0;
        retryAt = Date.now() + Math.min(retryMs * 2 ** Math.min(failures++, 4), 60000);
        child = undefined; exited = undefined;
      }
      if (!child && Date.now() >= retryAt && !await connected({ host: context.gateway.hostname.replace(/^\[|\]$/g, ''), port: Number(context.gateway.port || (context.gateway.protocol === 'https:' ? 443 : 80)) })) {
        const { record } = context;
        try {
          const envOptions = readNodeOptions(await fs.readFile(record.envFile, 'utf8'));
          const env = { ...process.env, NODE_OPTIONS: addPreload(process.env.NODE_OPTIONS ?? envOptions, record.preload),
            OMNI_SYNC_DATA_DIR: context.directory, OMNI_SYNC_CONFIG_FILE: context.configPath,
            DATA_DIR: record.omniDataDir || path.dirname(record.envFile) };
          const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') || 'PATH';
          env[pathKey] = path.dirname(record.nodePath) + path.delimiter + (env[pathKey] || '');
          child = spawn(record.nodePath, [record.cliPath, ...record.serveArgs], {
            cwd: record.omniInstallDir, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
          });
          child.once('exit', (code, childSignal) => { exited = { code, signal: childSignal }; });
          // Drain output; only fixed diagnostic categories can reach the log.
          const classify = data => {
            const text = data.toString();
            for (const code of STARTUP_CODES) if (text.includes(code)) errorCodes.add(code);
          };
          child.stdout.on('data', classify); child.stderr.on('data', classify);
          await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
          startedAt = Date.now();
          await log({ event: 'gateway-started', childPid: child.pid });
        } catch (error) {
          await log({ event: 'launch-failed', code: STARTUP_CODES.includes(error.code) ? error.code : 'STARTUP_CONFIGURATION' });
          child = undefined; exited = undefined;
          retryAt = Date.now() + Math.min(retryMs * 2 ** Math.min(failures++, 4), 60000);
        }
      }
      const health = await integratedHealth(context);
      const nextPhase = health.ready ? 'ready' : child ? 'starting' : Date.now() < retryAt ? 'retrying' : 'waiting-for-gateway';
      if (nextPhase !== phase || errorCodes.size) {
        await log({ event: 'health', phase: nextPhase, gatewayHttp: health.gatewayHttp, syncHttp: health.syncHttp, errorCodes: [...errorCodes] });
        phase = nextPhase; errorCodes.clear();
      }
      const status = { phase, supervisorPid: process.pid, childPid: child?.pid, ...health, updatedAt: new Date().toISOString() };
      try { await saveStatus(context.directory, status); }
      catch { await log({ event: 'status-write-failed', code: 'DIAGNOSTICS_UNAVAILABLE' }); }
      try { await delay(pollMs, undefined, { signal }); } catch (error) { if (!signal?.aborted) throw error; }
    }
  } finally {
    await stopChild(child);
    await log({ event: 'supervisor-stopped', processId: process.pid }).catch(() => {});
    await release();
  }
  return { success: true, stopped: true };
}
