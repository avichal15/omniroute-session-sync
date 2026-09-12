import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { SyncService } from './syncService.mjs';
import { OmniClient } from './omniClient.mjs';
import { loadState } from './runtimeState.mjs';
import { gatewayHeaders } from './gatewayAuth.mjs';
import { BridgeError, publicError } from './errors.mjs';

const EXTENSION_ORIGIN = /^chrome-extension:\/\/[a-p]{32}$/;
const MAX_BODY_BYTES = 512 * 1024;
function sameSecret(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || left.length !== right.length) return false;
  const leftBytes = Buffer.from(left); const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}
async function readBody(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || ''))
    throw new BridgeError('JSON_REQUIRED', 'Use application/json', 415);
  if (Number(req.headers['content-length'] || 0) > MAX_BODY_BYTES)
    throw new BridgeError('BODY_TOO_LARGE', 'Request body exceeds the size limit', 413);
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new BridgeError('BODY_TOO_LARGE', 'Request body exceeds the size limit', 413);
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return body;
  } catch { throw new BridgeError('INVALID_JSON', 'A JSON object is required'); }
}

export function createBridge({ gateway, service, state, persist, lifecycle = 'standalone' }) {
  const runtime = { lifecycle, processId: process.pid };
  let pairing = null; let pairingAttempts = []; let requests = [];
  let activeProtected = 0; let pairingInProgress = false;
  let readiness = { checkedAt: 0, ready: false };
  function reply(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'" });
    res.end(JSON.stringify(data));
  }
  async function ready() {
    if (Date.now() - readiness.checkedAt < 3000) return readiness;
    try { await gateway.listConnections(); readiness = { checkedAt: Date.now(), ready: true }; }
    catch (error) { readiness = { checkedAt: Date.now(), ready: false, error: publicError(error).message }; }
    return readiness;
  }
  const server = http.createServer((req, res) => {
    handle(req, res).catch(error => {
      req.resume();
      if (!res.headersSent && !res.destroyed) reply(res, error instanceof BridgeError ? error.status : 500,
        { success: false, error: publicError(error) });
      else if (!res.destroyed) res.end();
    });
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  server.maxHeadersCount = 40;
  async function handle(req, res) {
    if (!/^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i.test(req.headers.host || '') || !req.url?.startsWith('/') || req.url.startsWith('//'))
      throw new BridgeError('INVALID_REQUEST_TARGET', 'Invalid local request target');
    let pathname;
    try { pathname = new URL(req.url, 'http://localhost').pathname; }
    catch { throw new BridgeError('INVALID_REQUEST_TARGET', 'Invalid request URL'); }
    const origin = req.headers.origin;
    const isPair = pathname === '/api/pair';
    const isHealth = pathname === '/health' || pathname === '/';
    const protectedRequest = !isPair && !(isHealth && req.method === 'GET') && req.method !== 'OPTIONS';
    if (protectedRequest) activeProtected++;
    try {
      if (origin && !((isPair || isHealth) ? EXTENSION_ORIGIN.test(origin) : origin === state.client?.origin))
        throw new BridgeError('ORIGIN_REJECTED', 'This origin is not paired with the bridge', 403);
      if (origin) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      }
      if (protectedRequest && pairingInProgress)
        throw new BridgeError('BUSY', 'Pairing is in progress. Retry this request shortly.', 409);
      if (req.method === 'OPTIONS') return reply(res, 204, {});
      const now = Date.now();
      requests = requests.filter(time => now - time < 60000);
      if (requests.length >= 240) throw new BridgeError('RATE_LIMITED', 'Too many bridge requests; retry shortly', 429);
      requests.push(now);
      if (isHealth && req.method === 'GET') {
        // Liveness must not depend on a potentially busy OmniRoute event loop.
        // Chrome can keep its session update pending and retry once the gateway is
        // available again, but it must not mistake that for a dead local bridge.
        return reply(res, 200, { service: 'omniroute-session-sync', version: '2.0.0', alive: true,
          ready: readiness.ready === true, gatewayReady: readiness.ready === true,
          paired: Boolean(state.client), runtime });
      }
      const token = /^Bearer (.+)$/.exec(req.headers.authorization || '')?.[1];
      const owner = !origin && sameSecret(token, state.ownerToken);
      const client = sameSecret(token, state.client?.token);
      if (!isPair && !owner && !client) throw new BridgeError('UNAUTHORIZED', 'Pair the extension before using the bridge', 401);
      if (pathname === '/api/pairing-code' && req.method === 'POST') {
        if (!owner) throw new BridgeError('OWNER_REQUIRED', 'Create pairing codes from the local command line', 403);
        await readBody(req);
        pairing = { code: randomBytes(6).toString('hex').toUpperCase(), expiresAt: now + 300000 };
        pairingAttempts = [];
        return reply(res, 200, { success: true, ...pairing });
      }
      if (isPair && req.method === 'POST') {
        if (!origin || !EXTENSION_ORIGIN.test(origin)) throw new BridgeError('EXTENSION_REQUIRED', 'Pair from the Chrome extension', 403);
        pairingAttempts = pairingAttempts.filter(time => now - time < 60000);
        if (pairingAttempts.length >= 5) throw new BridgeError('PAIRING_RATE_LIMIT', 'Too many pairing attempts; wait one minute', 429);
        pairingAttempts.push(now);
        const body = await readBody(req);
        if (pairingInProgress) throw new BridgeError('BUSY', 'Pairing is in progress. Retry shortly.', 409);
        if (!pairing || Date.now() > pairing.expiresAt || !sameSecret(String(body.code || '').trim().toUpperCase(), pairing.code))
          throw new BridgeError('INVALID_PAIRING_CODE', 'Pairing code is incorrect or expired', 401);
        if (activeProtected)
          throw new BridgeError('BUSY', 'The bridge is busy. Retry the same pairing code after current requests finish.', 409);
        const reserved = pairing;
        pairing = null;
        pairingInProgress = true;
        const newClient = { token: randomBytes(32).toString('hex'), origin };
        const candidate = { ...state, client: newClient, mappings: {}, statuses: {} };
        try {
          await persist(candidate);
          Object.assign(state, candidate);
        } catch (error) {
          pairing = reserved;
          throw error;
        } finally { pairingInProgress = false; }
        return reply(res, 200, { success: true, token: newClient.token });
      }
      if (pathname === '/api/gateway-auth' && req.method === 'POST') {
        if (!owner) throw new BridgeError('OWNER_REQUIRED', 'Gateway management credentials are configured locally', 403);
        const body = await readBody(req);
        if (typeof body.token !== 'string' || body.token.length < 16 || body.token.length > 8192 || /\s/.test(body.token))
          throw new BridgeError('INVALID_TOKEN', 'A valid OmniRoute management token is required');
        await service.serial('$gateway-auth', async () => {
          await gateway.listConnections({ headers: { Authorization: `Bearer ${body.token}` } });
          await service.commit(current => ({ ...current, managementToken: body.token }));
        });
        readiness.checkedAt = 0;
        return reply(res, 200, { success: true });
      }
      if (pathname === '/api/status' && req.method === 'GET') {
        let providers = []; let models = []; let error;
        try { providers = await service.status(); }
        catch (cause) { error = publicError(cause).message; }
        readiness = error
          ? { checkedAt: Date.now(), ready: false, error }
          : { checkedAt: Date.now(), ready: true };
        if (!error) { try { models = await gateway.listModels(); } catch { /* Sync remains available if model discovery fails. */ } }
        return reply(res, 200, { success: true, paired: Boolean(state.client), bridge: { ready: !error, error },
          providers, models, fallback: state.fallback, runtime });
      }
      if (pathname === '/api/needed' && req.method === 'GET')
        return reply(res, 200, { success: true, providers: await service.status() });
      if (req.method === 'POST') {
        const body = await readBody(req);
        if (pathname === '/api/mappings') return reply(res, 200, await service.setMapping(body.provider, body.connectionId));
        if (pathname === '/api/sync') return reply(res, 200, await service.sync(body));
        if (pathname === '/api/validate') return reply(res, 200, await service.validate(body.provider));
        if (pathname === '/api/fallback') return reply(res, 200, await service.saveFallback(body.models));
        if (pathname === '/api/sync/bulk') {
          if (!Array.isArray(body.updates) || body.updates.length > 6) throw new BridgeError('INVALID_BULK', 'Supply at most six provider updates');
          const results = [];
          for (const item of body.updates) {
            try { results.push({ provider: item?.provider, ...await service.sync(item || {}) }); }
            catch (error) { results.push({ success: false, error: publicError(error) }); }
          }
          const success = results.every(item => item.success);
          return reply(res, success ? 200 : 207, { success, count: results.filter(item => item.success).length, results });
        }
      }
      throw new BridgeError('NOT_FOUND', 'Endpoint not found', 404);
    } finally {
      if (protectedRequest) activeProtected--;
    }
  }
  return server;
}

export async function main({ lifecycle = process.env.OMNI_SYNC_LIFECYCLE || 'standalone' } = {}) {
  const config = JSON.parse(await fs.readFile(process.env.OMNI_SYNC_CONFIG_FILE || new URL('./config.json', import.meta.url), 'utf8'));
  if (config.host !== '127.0.0.1' || !Number.isInteger(config.port) || config.port < 1024 || config.port > 65535)
    throw new BridgeError('INVALID_CONFIG', 'Configure a loopback bridge port between 1024 and 65535', 500);
  const { state, persist, filename } = await loadState();
  const gateway = new OmniClient({ baseUrl: config.omnirouteBaseUrl, headers: gatewayHeaders(state, config), allowCloudSync: config.allowCloudSync === true });
  const service = new SyncService({ gateway, state, persist });
  const server = createBridge({ gateway, service, state, persist, lifecycle });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(config.port, config.host, resolve); });
  console.log(`Session Sync v2: http://${config.host}:${config.port}`);
  if (lifecycle === 'omniroute') console.log('Session Sync is running inside OmniRoute. Saved pairing resumes automatically.');
  if (lifecycle === 'sidecar') console.log('Session Sync is running as a supervised local sidecar. Saved pairing resumes automatically.');
  console.log(`Private bridge configuration: ${filename}`);
  console.log('To pair Chrome, run: node scripts/pair.mjs');
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { server.close(); server.closeIdleConnections(); });
  return server;
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => {
    console.error(error.code === 'EADDRINUSE' ? 'The bridge port is already in use. Use the running bridge or stop it before restarting.' : publicError(error).message);
    process.exitCode = 1;
  });
}
