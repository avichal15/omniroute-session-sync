import { PROVIDERS } from '../extension/lib/cookieExtractors.js';
import { BridgeError } from './errors.mjs';

export const MANAGED_ROUTE_DESCRIPTION = 'Managed by OmniRoute Session Sync v2';
export function loopbackUrl(input) {
  const url = new URL(input);
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname))
    throw new BridgeError('INVALID_GATEWAY_URL', 'The gateway must be a local loopback HTTP URL');
  return url.origin;
}

export class OmniClient {
  constructor({ baseUrl = 'http://127.0.0.1:20128', headers = () => ({}), timeoutMs = 10000, allowCloudSync = false }) {
    this.baseUrl = loopbackUrl(baseUrl); this.headers = headers; this.timeoutMs = timeoutMs; this.catalog = null;
    this.allowCloudSync = allowCloudSync;
  }
  async request(endpoint, { method = 'GET', body, timeoutMs = this.timeoutMs, headers } = {}) {
    try {
      const response = await fetch(this.baseUrl + endpoint, {
        method, headers: { ...(headers ?? await this.headers()), Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        await response.body?.cancel();
        if ([401, 403].includes(response.status)) throw new BridgeError('GATEWAY_AUTH_REQUIRED', 'OmniRoute management access is required. Run the gateway setup command.', 503);
        if (response.status === 404) throw new BridgeError('GATEWAY_NOT_FOUND', 'The OmniRoute connection or API endpoint was not found', 409);
        throw new BridgeError('GATEWAY_ERROR', `OmniRoute rejected the operation (HTTP ${response.status})`, 502);
      }
      let bytes = 0; const chunks = [];
      for await (const chunk of response.body) {
        bytes += chunk.length;
        if (bytes > 8 * 1024 * 1024) throw new BridgeError('GATEWAY_RESPONSE_TOO_LARGE', 'OmniRoute response exceeded the size limit', 502);
        chunks.push(chunk);
      }
      try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { throw new BridgeError('GATEWAY_INVALID_RESPONSE', 'OmniRoute returned an invalid JSON response', 502); }
    } catch (error) {
      if (error instanceof BridgeError) throw error;
      throw new BridgeError('GATEWAY_UNAVAILABLE', 'OmniRoute is unavailable or timed out', 503);
    }
  }
  async listConnections(options) {
    const result = await this.request('/api/providers', options);
    if (!Array.isArray(result.connections)) throw new BridgeError('GATEWAY_INVALID_RESPONSE', 'Unexpected OmniRoute connection response', 502);
    return result.connections.filter(row => Object.hasOwn(PROVIDERS, row.provider)).map(row => ({
      id: row.id, provider: row.provider, name: String(row.name || row.displayName || row.provider).slice(0, 200),
      isActive: row.isActive === true || row.isActive === 1, authType: row.authType,
    }));
  }
  async checkSyncDestination() {
    if (this.allowCloudSync) return;
    const settings = await this.request('/api/settings');
    if (settings?.cloudEnabled !== false)
      throw new BridgeError('CLOUD_SYNC_ENABLED', 'Disable OmniRoute cloud sync before saving browser sessions with this local-only bridge', 409);
  }
  async updateCredential(id, cookie) {
    await this.checkSyncDestination();
    const result = await this.request(`/api/providers/${encodeURIComponent(id)}`, { method: 'PUT', body: {
      apiKey: cookie, testStatus: 'unknown', lastError: null, lastErrorAt: null, lastErrorType: null, lastErrorSource: null, errorCode: null,
    } });
    if (result.error || result.success === false) throw new BridgeError('GATEWAY_WRITE_FAILED', 'OmniRoute did not confirm the credential update', 502);
    // Never return the management response; it may include credential-bearing fields.
    return { success: true };
  }
  async testConnection(id) {
    await this.checkSyncDestination();
    const result = await this.request(`/api/providers/${encodeURIComponent(id)}/test`, { method: 'POST', body: {}, timeoutMs: 22000 });
    return { valid: result.valid === true, unsupported: result.unsupported, diagnosis: result.diagnosis, error: result.error };
  }
  async listModels() {
    if (this.catalog && this.catalog.expires > Date.now()) return this.catalog.models;
    const result = await this.request('/api/combos/builder/options', { timeoutMs: 20000 });
    if (!Array.isArray(result.providers)) throw new BridgeError('GATEWAY_INVALID_RESPONSE', 'Unexpected OmniRoute model catalog', 502);
    const models = result.providers.filter(p => Object.hasOwn(PROVIDERS, p.providerId) && p.activeConnectionCount > 0)
      .flatMap(p => (p.models || []).filter(m => typeof m.qualifiedModel === 'string').map(m => ({
        id: m.qualifiedModel, provider: p.providerId, label: `${PROVIDERS[p.providerId].name} / ${m.name || m.id}`,
      })));
    this.catalog = { expires: Date.now() + 60000, models };
    return models;
  }
  async saveFallback(models, previous) {
    await this.checkSyncDestination();
    const result = await this.request('/api/combos');
    const existing = (result.combos || []).find(c => c.name === 'browser-sessions');
    if (existing && (existing.description !== MANAGED_ROUTE_DESCRIPTION || (previous.id && existing.id !== previous.id)))
      throw new BridgeError('ROUTE_NAME_CONFLICT', 'An unrelated browser-sessions route already exists; rename it in OmniRoute first', 409);
    const catalog = await this.listModels();
    const body = { name: 'browser-sessions', description: MANAGED_ROUTE_DESCRIPTION, strategy: 'priority', models,
      allowedProviders: [...new Set(models.map(id => catalog.find(m => m.id === id)?.provider).filter(Boolean))] };
    const saved = await this.request(existing ? `/api/combos/${encodeURIComponent(existing.id)}` : '/api/combos', {
      method: existing ? 'PUT' : 'POST', body,
    });
    const combo = saved.combo || saved;
    if (!combo.id) throw new BridgeError('GATEWAY_INVALID_RESPONSE', 'OmniRoute did not confirm the fallback route', 502);
    return { id: combo.id };
  }
}
