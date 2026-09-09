import fs from 'node:fs/promises';
import path from 'node:path';
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

if (isMainThread && await isOmniRouteServer(process.argv[1])) {
  try {
    // Bind before OmniRoute's entrypoint patches http.createServer for WebDAV/TLS.
    // Awaiting here also makes startup order deterministic without another daemon.
    await main({ lifecycle: 'omniroute' });
  } catch (error) {
    const reason = error?.code === 'EADDRINUSE'
      ? 'the sync port is already in use'
      : 'local sync configuration could not be loaded';
    console.error(`[Session Sync] Could not start: ${reason}. OmniRoute will continue starting.`);
  }
}
