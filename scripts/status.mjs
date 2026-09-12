import fs from 'node:fs/promises';
import path from 'node:path';
import { localRequest } from './bridge-client.mjs';
import { dataDirectory } from '../bridge/runtimeState.mjs';
import { supervisorRunning } from './integrated-runtime.mjs';
try {
  const result = await localRequest('/api/status');
  console.log(`OmniRoute: ${result.bridge.ready ? 'ready' : result.bridge.error || 'unavailable'}`);
  const lifecycle = result.runtime?.lifecycle;
  console.log(`Sync service: ${lifecycle === 'omniroute' ? 'embedded in OmniRoute; starts with the gateway'
    : lifecycle === 'sidecar' ? 'supervised sidecar; starts with the gateway' : 'standalone'}`);
  if (lifecycle === 'omniroute' || lifecycle === 'sidecar') console.log(`Startup recovery: ${await supervisorRunning(dataDirectory()) ? 'running' : 'not running'}`);
  console.log(`Chrome: ${result.paired ? 'paired' : 'not paired'}`);
  for (const p of result.providers) console.log(`${p.name}: ${p.phase}; connection ${p.connectionId || 'not selected'}; last saved ${p.lastSyncedAt || 'never'}`);
  console.log(`Fallback alias: ${result.fallback.saved ? result.fallback.name : 'not configured'}`);
  if (!result.bridge.ready) process.exitCode = 1;
} catch (error) {
  const directory = dataDirectory();
  const installed = await fs.access(path.join(directory, 'installation.json')).then(() => true, () => false);
  if (installed) {
    const running = await supervisorRunning(directory);
    console.error(`OmniRoute: ${running ? 'not ready; automatic startup recovery is running' : 'offline; startup recovery is not running'}`);
    const status = await fs.readFile(path.join(directory, 'startup-status.json'), 'utf8').then(JSON.parse).catch(() => null);
    if (status) console.log(`Last startup check: ${status.updatedAt}; ${status.phase}`);
    console.log(`Startup log: ${path.join(directory, 'startup.log')}`);
    if (!running) console.log('Start the saved setup with npm run start:integrated. Pairing is retained.');
  } else console.error(error.message);
  process.exitCode = 1;
}
