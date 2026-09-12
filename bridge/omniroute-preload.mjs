import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { isMainThread } from 'node:worker_threads';
import { main } from './server.mjs';

/** NODE_OPTIONS is inherited by helper processes; only the gateway owns sync. */
export async function isOmniRouteServer(scriptPath) {
  if (typeof scriptPath !== 'string') return false;
  try {
    const entry = await fs.realpath(scriptPath);
    if (!['server-ws.mjs', 'server.js'].includes(path.basename(entry))) return false;
    const bundle = path.dirname(entry);
    if (!['dist', 'app'].includes(path.basename(bundle))) return false;
    const manifest = JSON.parse(await fs.readFile(path.join(bundle, '..', 'package.json'), 'utf8'));
    return manifest.name === 'omniroute';
  } catch { return false; }
}

async function sidecarListening() {
  try {
    const configPath = process.env.OMNI_SYNC_CONFIG_FILE || new URL('./config.json', import.meta.url);
    const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
    if (config.host !== '127.0.0.1' || !Number.isInteger(config.port)) return false;
    return await new Promise(resolve => {
      const socket = net.createConnection({ host: config.host, port: config.port });
      const finish = value => { socket.destroy(); resolve(value); };
      socket.setTimeout(1000, () => finish(false));
      socket.once('connect', () => finish(true));
      socket.once('error', () => finish(false));
    });
  } catch { return false; }
}

if (isMainThread && await isOmniRouteServer(process.argv[1])) {
  try {
    // A supervised sidecar owns the port when launched by Session Sync v2. Keep
    // this fallback for older installations and manual OmniRoute launches.
    if (!await sidecarListening()) await main({ lifecycle: 'omniroute' });
  } catch (error) {
    const reason = error?.code === 'EADDRINUSE'
      ? 'the sync port is already in use'
      : 'local sync configuration could not be loaded';
    console.error(`[Session Sync] Could not start: ${reason}. OmniRoute will continue starting.`);
  }
}
