import { createHash } from 'node:crypto';
import { PROVIDERS, validCredential } from '../extension/lib/cookieExtractors.js';
import { BridgeError } from './errors.mjs';

export class SyncService {
  constructor({ gateway, state, persist }) {
    this.gateway = gateway; this.state = state; this.persist = persist; this.queues = new Map();
    this.commits = Promise.resolve();
    state.mappings ??= {}; state.statuses ??= {};
    state.fallback ??= { name: 'browser-sessions', models: [], saved: false };
  }
  serial(provider, operation) {
    const pending = (this.queues.get(provider) || Promise.resolve()).catch(() => {}).then(operation);
    this.queues.set(provider, pending);
    pending.finally(() => { if (this.queues.get(provider) === pending) this.queues.delete(provider); }).catch(() => {});
    return pending;
  }
  commit(update) {
    // Build from the last successful snapshot; network work stays outside this queue.
    const pending = this.commits.then(async () => {
      const candidate = update(this.state);
      await this.persist(candidate);
      Object.assign(this.state, candidate);
      return candidate;
    });
    this.commits = pending.catch(() => {});
    return pending;
  }
  checkProvider(provider) {
    if (!Object.hasOwn(PROVIDERS, provider)) throw new BridgeError('UNSUPPORTED_PROVIDER', 'Unsupported browser provider');
  }
  async connection(provider, id) {
    this.checkProvider(provider);
    const row = (await this.gateway.listConnections()).find(item => item.id === id);
    if (!row || row.provider !== provider) throw new BridgeError('CONNECTION_MISMATCH', 'Choose a connection belonging to this provider', 409);
    if (!row.isActive) throw new BridgeError('CONNECTION_DISABLED', 'The selected connection must be active', 409);
    if (row.authType !== 'apikey') throw new BridgeError('AUTH_TYPE_UNSUPPORTED', 'Use an API-key connection for this browser provider', 409);
    return row;
  }
  setMapping(provider, connectionId) {
    this.checkProvider(provider);
    return this.serial(provider, async () => {
      if (connectionId !== null) await this.connection(provider, connectionId);
      if (connectionId === this.state.mappings[provider]) return { success: true };
      await this.commit(current => {
        const mappings = { ...current.mappings };
        if (connectionId === null) delete mappings[provider];
        else mappings[provider] = connectionId;
        return { ...current, mappings, statuses: { ...current.statuses,
          [provider]: { phase: connectionId ? 'pending' : 'unmapped' } } };
      });
      return { success: true };
    });
  }
  sync(input) {
    this.checkProvider(input.provider);
    return this.serial(input.provider, async () => {
      const { provider, connectionId, cookie, revision, force = false } = input;
      if (!connectionId || this.state.mappings[provider] !== connectionId)
        throw new BridgeError('NOT_MAPPED', 'This connection is not mapped to the paired browser provider', 409);
      if (!validCredential(provider, cookie)) throw new BridgeError('INVALID_CREDENTIAL', 'No complete authentication session was supplied');
      if (!Number.isSafeInteger(revision) || revision < 1) throw new BridgeError('INVALID_REVISION', 'A positive session revision is required');
      await this.connection(provider, connectionId);
      const previous = this.state.statuses[provider];
      const fingerprint = createHash('sha256').update(connectionId + '\0' + cookie).digest('hex');
      if (previous?.revision > revision) return { success: true, stale: true, skipped: true, revision: previous.revision };
      if (previous?.revision === revision && previous.fingerprint && previous.fingerprint !== fingerprint)
        throw new BridgeError('REVISION_CONFLICT', 'Session revision was reused with different credentials', 409);
      const unchanged = previous?.fingerprint === fingerprint && !force;
      if (!unchanged) await this.gateway.updateCredential(connectionId, cookie);
      const status = unchanged ? { ...previous, revision } : {
        phase: 'synced', connectionId, fingerprint, revision, lastSyncedAt: new Date().toISOString(),
        message: 'Saved to OmniRoute; session validation is separate',
      };
      await this.commit(current => ({ ...current, statuses: { ...current.statuses, [provider]: status } }));
      return { success: true, skipped: unchanged, revision, phase: status.phase };
    });
  }
  validate(provider) {
    this.checkProvider(provider);
    return this.serial(provider, async () => {
      const id = this.state.mappings[provider];
      if (!id) throw new BridgeError('NOT_MAPPED', 'Select a connection first', 409);
      await this.connection(provider, id);
      const result = await this.gateway.testConnection(id);
      const previous = this.state.statuses[provider] || {};
      const unsupported = result.unsupported || result.diagnosis?.unsupported || result.diagnosis?.type === 'unsupported'
        || /not supported|unsupported/i.test(result.error || '');
      const loginRequired = ['upstream_auth_error', 'token_refresh_failed', 'token_expired'].includes(result.diagnosis?.type)
        || ['401', '403', 'SESSION_EXPIRED', 'AUTH_007'].includes(String(result.diagnosis?.code || ''))
        || /SESSION_EXPIRED|AUTH_007|401|login|sign.in|expired|invalid.*token/i.test(result.error || '')
        || result.diagnosis?.category === 'auth';
      const phase = result.valid === true ? 'validated' : unsupported ? 'synced' : loginRequired ? 'login-required' : 'error';
      const status = { ...previous, phase, ...(result.valid === true ? { lastValidatedAt: new Date().toISOString() } : {}),
        message: result.valid === true ? 'OmniRoute accepted the session test'
          : unsupported ? 'Saved; this provider has no reliable session test'
          : loginRequired ? 'Sign in to the provider in Chrome, then sync again'
          : 'OmniRoute could not validate the session; check the provider dashboard' };
      await this.commit(current => ({ ...current, statuses: { ...current.statuses, [provider]: status } }));
      return { success: true, valid: result.valid === true, phase, message: status.message };
    });
  }
  async status() {
    const connections = await this.gateway.listConnections();
    return Object.entries(PROVIDERS).map(([provider, meta]) => {
      const { phase, message, lastSyncedAt, lastValidatedAt, revision } = this.state.statuses[provider] || {};
      return { provider, name: meta.name, connectionId: this.state.mappings[provider] || null,
        connections: connections.filter(c => c.provider === provider),
        phase: phase || (this.state.mappings[provider] ? 'pending' : 'unmapped'), message, lastSyncedAt, lastValidatedAt, revision };
    });
  }
  saveFallback(models) {
    return this.serial('$fallback', async () => {
      if (!Array.isArray(models) || models.length < 1 || models.length > 8 || new Set(models).size !== models.length)
        throw new BridgeError('INVALID_FALLBACK', 'Choose between one and eight different models in priority order');
      const available = await this.gateway.listModels();
      if (models.some(id => !available.some(m => m.id === id && Object.hasOwn(PROVIDERS, m.provider))))
        throw new BridgeError('MODEL_NOT_ALLOWED', 'Only available browser-provider models may be used');
      const result = await this.gateway.saveFallback(models, this.state.fallback);
      const fallback = { name: 'browser-sessions', id: result.id, models: [...models], saved: true };
      await this.commit(current => ({ ...current, fallback }));
      return { success: true, fallback };
    });
  }
}
