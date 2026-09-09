import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dataDirectory } from '../bridge/runtimeState.mjs';
import { addPreload, readNodeOptions } from './embedded-install-lib.mjs';
import { loopbackUrl } from '../bridge/omniClient.mjs';

function portInUse(url) {
  return new Promise(resolve => {
    const socket = net.createConnection({ host: url.hostname.replace(/^\[|\]$/g, ''), port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)) });
    const finish = value => { socket.destroy(); resolve(value); };
    socket.setTimeout(1500, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

export async function startIntegrated() {
  const record = JSON.parse(await fs.readFile(path.join(dataDirectory(), 'installation.json'), 'utf8'));
  if (record.version !== 1 || ![record.nodePath, record.cliPath, record.projectDir, record.envFile].every(value => typeof value === 'string' && path.isAbsolute(value)))
    throw new Error('Run embedded setup once before launching.');
  const config = JSON.parse(await fs.readFile(path.join(record.projectDir, 'bridge', 'config.json'), 'utf8'));
  const gateway = new URL(loopbackUrl(config.omnirouteBaseUrl));
  if (await portInUse(gateway)) return { success: true, alreadyRunning: true };
  const envOptions = readNodeOptions(await fs.readFile(record.envFile, 'utf8'));
  const nodeOptions = addPreload(process.env.NODE_OPTIONS ?? envOptions, record.preload);
  // Preserve inherited flags and pin the child supervisor's literal `node` lookup.
  const childEnv = { ...process.env, NODE_OPTIONS: nodeOptions };
  const pathKey = Object.keys(childEnv).find(key => key.toLowerCase() === 'path') || 'PATH';
  childEnv[pathKey] = path.dirname(record.nodePath) + path.delimiter + (childEnv[pathKey] || '');
  const child = spawn(record.nodePath, [record.cliPath, ...record.serveArgs], {
    cwd: record.omniInstallDir, env: childEnv, detached: true, windowsHide: true, stdio: 'ignore'
  });
  // Start the actual CLI, retaining its normal process-recovery supervisor.
  // The executable path is separate from the CLI argv to preserve Windows quoting.
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  child.unref();
  return { success: true, started: true, processId: child.pid };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startIntegrated().then(result => console.log(JSON.stringify(result)), () => {
    console.error('OmniRoute could not start. Run the one-time embedded setup and check that Node.js is installed.');
    process.exitCode = 1;
  });
}
