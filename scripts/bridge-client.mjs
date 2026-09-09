import fs from 'node:fs/promises';
import path from 'node:path';
import { dataDirectory } from '../bridge/runtimeState.mjs';

export async function localRequest(endpoint, body) {
  const config = JSON.parse(await fs.readFile(process.env.OMNI_SYNC_CONFIG_FILE || new URL('../bridge/config.json', import.meta.url), 'utf8'));
  let state;
  try { state = JSON.parse(await fs.readFile(path.join(dataDirectory(), 'state.json'), 'utf8')); }
  catch { throw new Error('Start the bridge first with npm start.'); }
  const response = await fetch(`http://${config.host}:${config.port}${endpoint}`, {
    method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${state.ownerToken}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000),
  });
  const result = await response.json();
  if (!response.ok || result.success === false) throw new Error(result.error?.message || 'Bridge operation failed');
  return result;
}
