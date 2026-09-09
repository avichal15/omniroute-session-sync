import { localRequest } from './bridge-client.mjs';
try {
  const result = await localRequest('/api/status');
  console.log(`OmniRoute: ${result.bridge.ready ? 'ready' : result.bridge.error || 'unavailable'}`);
  console.log(`Chrome: ${result.paired ? 'paired' : 'not paired'}`);
  for (const p of result.providers) console.log(`${p.name}: ${p.phase}; connection ${p.connectionId || 'not selected'}; last saved ${p.lastSyncedAt || 'never'}`);
  console.log(`Fallback alias: ${result.fallback.saved ? result.fallback.name : 'not configured'}`);
  if (!result.bridge.ready) process.exitCode = 1;
} catch (error) { console.error(error.message); process.exitCode = 1; }
