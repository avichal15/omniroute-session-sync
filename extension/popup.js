'use strict';

// Provider IDs, rather than authType, distinguish browser sessions from official APIs.
const BROWSER_PROVIDERS = new Set([
  'chatgpt-web', 'gemini-web', 'zai-web', 'qwen-web', 'grok-web', 'deepseek-web'
]);
const PHASE_LABELS = {
  unmapped: 'Not mapped', pending: 'Pending', synced: 'Synced',
  validated: 'Validated', 'login-required': 'Sign-in required', error: 'Error'
};

document.addEventListener('DOMContentLoaded', () => {
  const ui = Object.fromEntries([
    'bridgeStatusBadge', 'statusNotice', 'pairingSection', 'pairedContent', 'pairForm',
    'pairCode', 'pairBtn', 'pairFeedback', 'providersList', 'syncAllBtn', 'fallbackList',
    'fallbackSavedBadge', 'fallbackEmpty', 'fallbackModel', 'addModelBtn', 'fallbackCount',
    'saveFallbackBtn', 'fallbackFeedback', 'actionFeedback', 'refreshBtn'
  ].map(id => [id, document.getElementById(id)]));
  const state = {
    status: null, available: false, refreshing: false, requestId: 0,
    pairing: false, syncingAll: false, savingFallback: false,
    providers: new Map(), busy: new Map(), views: new Map(), models: new Map(),
    fallback: [], fallbackDirty: false, fallbackLoaded: false
  };

  function messageOf(error, fallback = 'The request could not be completed.') {
    const message = typeof error === 'string' ? error : error?.message;
    return typeof message === 'string' && message.trim() ? message.slice(0, 600) : fallback;
  }

  function text(node, value) {
    if (node.textContent !== value) node.textContent = value;
  }

  function feedback(node, message, kind = '') {
    text(node, message);
    node.dataset.state = kind;
  }

  function element(tag, className = '', content = '') {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (content) node.textContent = content;
    return node;
  }

  function option(value, label, disabled = false) {
    const node = element('option', '', label);
    node.value = value;
    node.disabled = disabled;
    return node;
  }

  function button(label, className, action) {
    const node = element('button', `button ${className}`, label);
    node.type = 'button';
    node.addEventListener('click', action);
    return node;
  }

  function send(payload) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('The bridge took too long to respond. Refresh to check its status.')), 60000);
      try {
        chrome.runtime.sendMessage(payload, response => {
          clearTimeout(timeout);
          const error = chrome.runtime.lastError;
          if (error) reject(new Error(messageOf(error)));
          else if (!response?.success) reject(new Error(messageOf(response?.error, 'The extension could not complete the request.')));
          else resolve(response);
        });
      } catch (error) {
        clearTimeout(timeout);
        reject(error);
      }
    });
  }

  const bridgeReady = () => state.available && state.status?.paired === true && state.status?.bridge?.ready === true;
  const usable = connection => Boolean(connection && connection.isActive === true && connection.authType === 'apikey');
  const connectionsFor = provider => Array.isArray(provider?.connections)
    ? provider.connections.filter(connection => typeof connection?.id === 'string' && connection.id) : [];
  const mappedConnection = provider => connectionsFor(provider).find(connection => connection.id === provider.connectionId);
  const providerBusy = provider => state.syncingAll || state.busy.has(provider.provider) || provider.phase === 'pending';

  function timestamp(value) {
    if (!value) return 'Never';
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return 'Unknown';
    return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }

  function createProviderView(provider) {
    const key = provider.provider;
    const card = element('article', 'provider-card');
    const heading = element('div', 'provider-heading');
    const name = element('h3');
    name.id = `name-${key}`;
    card.setAttribute('aria-labelledby', name.id);
    const phase = element('span', 'badge');
    heading.append(name, phase);
    const session = element('p', 'provider-session');
    const label = element('label', '', 'OmniRoute connection');
    label.htmlFor = `connection-${key}`;
    const select = element('select');
    select.id = label.htmlFor;
    select.setAttribute('aria-label', `${provider.name || key} OmniRoute connection`);
    const apply = button('Apply', '', () => runProvider(key, 'MAP_PROVIDER'));
    apply.setAttribute('aria-label', `Apply ${provider.name || key} connection`);
    const mapping = element('div', 'input-row mapping-row');
    mapping.append(select, apply);
    const actions = element('div', 'provider-actions');
    const sync = button('Sync', 'button-small', () => runProvider(key, 'SYNC_ONE'));
    const test = button('Test', 'button-small', () => runProvider(key, 'VALIDATE_PROVIDER'));
    sync.setAttribute('aria-label', `Sync ${provider.name || key}`);
    test.setAttribute('aria-label', `Test ${provider.name || key}`);
    actions.append(sync, test);
    const message = element('p', 'provider-message');
    message.id = `message-${key}`;
    select.setAttribute('aria-describedby', message.id);
    const times = element('p', 'provider-times');
    const notice = element('p', 'feedback');
    notice.setAttribute('role', 'status');
    notice.setAttribute('aria-live', 'polite');
    card.append(heading, session, label, mapping, actions, message, times, notice);
    const view = { card, name, phase, session, select, apply, sync, test, message, times, notice,
      draft: provider.connectionId || '', dirty: false, optionsKey: '' };
    select.addEventListener('change', () => {
      view.draft = select.value;
      view.dirty = view.draft !== (state.providers.get(key)?.connectionId || '');
      feedback(notice, '');
      renderProvider(state.providers.get(key), view);
      renderControls();
    });
    select.addEventListener('blur', () => renderProvider(state.providers.get(key), view));
    state.views.set(key, view);
    ui.providersList.append(card);
    return view;
  }

  function renderProvider(provider, view) {
    if (!provider) return;
    const focused = document.activeElement === view.select;
    if (!view.dirty && !focused) view.draft = provider.connectionId || '';
    const connections = connectionsFor(provider);
    const optionsKey = JSON.stringify(connections.map(item => [item.id, item.name, item.isActive, item.authType])) + view.draft;
    // Leave native selects intact while they are open, including during timed refreshes.
    if (view.optionsKey !== optionsKey && !focused) {
      const options = [option('', 'Choose connection')];
      for (const connection of connections) {
        const reason = !connection.isActive ? ' · disabled' : connection.authType !== 'apikey' ? ' · unsupported type' : '';
        options.push(option(connection.id, `${connection.name || connection.id}${reason}`, !usable(connection)));
      }
      if (view.draft && !connections.some(item => item.id === view.draft)) {
        options.push(option(view.draft, 'Unavailable connection', true));
      }
      view.select.replaceChildren(...options);
      view.select.value = view.draft;
      view.optionsKey = optionsKey;
    }
    const busy = providerBusy(provider);
    const operation = state.busy.get(provider.provider);
    const batchTarget = state.syncingAll && provider.hasCredentials && usable(mappedConnection(provider));
    const working = Boolean(operation || batchTarget || provider.phase === 'pending');
    const phase = working ? 'pending' : (Object.hasOwn(PHASE_LABELS, provider.phase) ? provider.phase : 'error');
    text(view.name, provider.name || provider.provider);
    text(view.phase, PHASE_LABELS[phase]);
    view.phase.dataset.state = phase;
    text(view.session, provider.hasCredentials ? 'Browser session found' : 'Browser login needed');
    view.card.setAttribute('aria-busy', String(working));
    view.select.disabled = !bridgeReady() || busy;
    const validDraft = !view.draft || usable(connections.find(item => item.id === view.draft));
    view.apply.disabled = !bridgeReady() || busy || !view.dirty || !validDraft;
    const mapped = usable(mappedConnection(provider));
    view.sync.disabled = !bridgeReady() || busy || view.dirty || !mapped || !provider.hasCredentials;
    view.test.disabled = !bridgeReady() || busy || view.dirty || !mapped;
    text(view.apply, operation === 'MAP_PROVIDER' ? 'Saving…' : 'Apply');
    text(view.sync, operation === 'SYNC_ONE' || batchTarget ? 'Syncing…' : 'Sync');
    text(view.test, operation === 'VALIDATE_PROVIDER' ? 'Testing…' : 'Test');
    let help = 'Sync updates the connection. Test checks whether its session works.';
    if (!bridgeReady()) help = 'Connect to the local bridge to manage this provider.';
    else if (view.dirty) help = validDraft ? 'Apply this connection choice before syncing or testing.' : 'This connection is unavailable or disabled. Choose an active connection.';
    else if (!provider.connectionId) help = 'Choose an active OmniRoute connection, then Apply.';
    else if (!mapped) help = 'The mapped connection is unavailable, disabled, or unsupported. Choose another connection.';
    else if (!provider.hasCredentials) help = `Sign in to ${provider.name || provider.provider} in this browser to sync.`;
    else if (provider.phase === 'synced') help = 'Session synced. Run Test to verify access.';
    else if (provider.phase === 'validated') help = 'The last connection test passed.';
    if (!view.dirty && mapped && bridgeReady() && typeof provider.message === 'string' && provider.message.trim()) help = provider.message.slice(0, 600);
    text(view.message, help);
    text(view.times, `Synced: ${timestamp(provider.lastSyncedAt)} · Validated: ${timestamp(provider.lastValidatedAt)}`);
  }

  function renderProviders() {
    for (const [key, view] of state.views) {
      if (!state.providers.has(key)) { view.card.remove(); state.views.delete(key); }
    }
    const empty = ui.providersList.querySelector('.empty-state');
    if (state.providers.size) empty?.remove();
    else if (!empty) ui.providersList.append(element('p', 'empty-state', 'No browser providers are available. Refresh after the bridge is ready.'));
    for (const provider of state.providers.values()) renderProvider(provider, state.views.get(provider.provider) || createProviderView(provider));
  }

  async function runProvider(key, action) {
    const provider = state.providers.get(key);
    const view = state.views.get(key);
    if (!provider || !view || !bridgeReady() || providerBusy(provider)) return;
    const control = action === 'MAP_PROVIDER' ? view.apply : action === 'SYNC_ONE' ? view.sync : view.test;
    if (control.disabled) return;
    state.busy.set(key, action);
    renderProviders();
    renderControls();
    feedback(view.notice, action === 'VALIDATE_PROVIDER' ? 'Testing the connection…' : action === 'SYNC_ONE' ? 'Syncing the browser session…' : 'Saving connection mapping…', 'pending');
    try {
      const payload = { action, provider: key };
      if (action === 'MAP_PROVIDER') payload.connectionId = view.draft || null;
      await send(payload);
      if (action === 'MAP_PROVIDER') {
        // Keep the confirmed choice visible even if the status refresh fails.
        const current = state.providers.get(key);
        if (current) current.connectionId = payload.connectionId;
        view.dirty = false;
      }
      feedback(view.notice, action === 'MAP_PROVIDER' ? 'Connection mapping saved.' : action === 'SYNC_ONE' ? 'Sync completed. Run Test to verify access.' : 'Connection test completed.', 'success');
    } catch (error) {
      feedback(view.notice, messageOf(error), 'error');
    } finally {
      state.busy.delete(key);
      await refreshStatus(true);
      renderProviders();
      renderControls();
    }
  }

  function renderModelPicker() {
    if (document.activeElement === ui.fallbackModel) return;
    const selected = ui.fallbackModel.value;
    ui.fallbackModel.replaceChildren(option('', state.models.size ? 'Choose a browser model' : 'No browser models available'));
    for (const model of state.models.values()) {
      ui.fallbackModel.append(option(model.id, `${model.label || model.id} · ${model.provider}`, state.fallback.includes(model.id)));
    }
    ui.fallbackModel.value = state.models.has(selected) && !state.fallback.includes(selected) ? selected : '';
  }

  function editFallback(action, index) {
    if (state.savingFallback) return;
    const model = state.models.get(state.fallback[index]);
    if (action === 'remove') state.fallback.splice(index, 1);
    else {
      const next = action === 'up' ? index - 1 : index + 1;
      if (next < 0 || next >= state.fallback.length) return;
      [state.fallback[index], state.fallback[next]] = [state.fallback[next], state.fallback[index]];
      index = next;
    }
    state.fallbackDirty = true;
    renderFallback();
    feedback(ui.fallbackFeedback, action === 'remove' ? 'Model removed. Save to apply this order.' : `${model?.label || 'Model'} moved to position ${index + 1}. Save to apply this order.`);
    const row = ui.fallbackList.children[Math.min(index, state.fallback.length - 1)];
    const focus = row?.querySelector(`[data-action="${action}"]:not(:disabled)`) || row?.querySelector('button:not(:disabled)') || ui.fallbackModel;
    focus.focus();
  }

  function renderFallback() {
    ui.fallbackList.replaceChildren();
    for (const [index, id] of state.fallback.entries()) {
      const model = state.models.get(id);
      const item = element('li');
      const row = element('div', 'model-row');
      const info = element('div', 'model-info');
      const name = model?.label || id;
      info.append(element('div', `model-name${model ? '' : ' model-unavailable'}`, model ? name : 'Unavailable model'));
      info.append(element('code', 'model-id', id));
      const actions = element('div', 'model-actions');
      for (const [action, label, title] of [['up', '↑', `Move ${name} up`], ['down', '↓', `Move ${name} down`], ['remove', 'Remove', `Remove ${name}`]]) {
        const control = button(label, action === 'remove' ? '' : 'move-button', () => editFallback(action, index));
        control.dataset.action = action;
        control.setAttribute('aria-label', title);
        control.title = title;
        control.disabled = state.savingFallback || (action === 'up' && index === 0) || (action === 'down' && index === state.fallback.length - 1);
        actions.append(control);
      }
      row.append(info, actions);
      item.append(row);
      ui.fallbackList.append(item);
    }
    ui.fallbackEmpty.hidden = state.fallback.length > 0;
    renderModelPicker();
    renderControls();
  }

  function renderControls() {
    const ready = bridgeReady();
    const busy = state.syncingAll || state.busy.size > 0 || [...state.providers.values()].some(provider => provider.phase === 'pending');
    // Sync all uses saved mappings; wait until every draft has been applied.
    const hasDrafts = [...state.views.values()].some(view => view.dirty);
    const syncable = [...state.providers.values()].some(provider => provider.hasCredentials && usable(mappedConnection(provider)) && provider.phase !== 'pending');
    ui.syncAllBtn.disabled = !ready || busy || hasDrafts || !syncable;
    text(ui.syncAllBtn, state.syncingAll ? 'Syncing…' : 'Sync all');
    ui.pairBtn.disabled = state.pairing || !ui.pairCode.value.trim();
    ui.pairCode.disabled = state.pairing;
    text(ui.pairBtn, state.pairing ? 'Pairing…' : 'Pair browser');
    ui.refreshBtn.disabled = state.refreshing;
    text(ui.refreshBtn, state.refreshing ? 'Refreshing…' : 'Refresh');
    ui.fallbackModel.disabled = state.savingFallback || !state.models.size || state.fallback.length >= 8;
    ui.addModelBtn.disabled = ui.fallbackModel.disabled || !state.models.has(ui.fallbackModel.value) || state.fallback.includes(ui.fallbackModel.value);
    const valid = state.fallback.length >= 1 && state.fallback.length <= 8 && new Set(state.fallback).size === state.fallback.length && state.fallback.every(id => state.models.has(id));
    ui.saveFallbackBtn.disabled = !ready || state.savingFallback || !valid || (!state.fallbackDirty && state.status?.fallback?.saved === true);
    text(ui.saveFallbackBtn, state.savingFallback ? 'Saving…' : 'Save fallback');
    const unavailable = state.fallback.some(id => !state.models.has(id));
    text(ui.fallbackCount, `${state.fallback.length} of 8 models${unavailable ? ' · remove unavailable models' : ''}`);
    const saved = state.status?.fallback?.saved === true && !state.fallbackDirty;
    text(ui.fallbackSavedBadge, state.fallbackDirty ? 'Unsaved changes' : saved ? 'Saved' : 'Not saved');
    ui.fallbackSavedBadge.dataset.state = saved ? 'online' : '';
  }

  function acceptStatus(status) {
    state.status = status;
    state.available = true;
    const paired = status.paired === true;
    ui.pairingSection.hidden = paired;
    ui.pairedContent.hidden = !paired;
    text(ui.bridgeStatusBadge, paired ? (status.bridge?.ready ? 'Bridge ready' : 'Bridge offline') : 'Not paired');
    ui.bridgeStatusBadge.dataset.state = paired && status.bridge?.ready ? 'online' : paired ? 'error' : '';
    feedback(ui.statusNotice, !paired ? 'Pair once to connect this extension to your local bridge.' : status.bridge?.ready ? 'Paired locally. Status refreshes every 5 seconds while open.' : messageOf(status.bridge?.error, 'The local bridge is unavailable. Start it, then Refresh.'), paired && !status.bridge?.ready ? 'error' : '');
    const providers = Array.isArray(status.providers) ? status.providers : [];
    state.providers = new Map(providers.filter(provider => BROWSER_PROVIDERS.has(provider?.provider)).map(provider => [provider.provider, provider]));
    const models = Array.isArray(status.models) ? status.models : [];
    state.models = new Map(models.filter(model => BROWSER_PROVIDERS.has(model?.provider) && typeof model.id === 'string' && model.id).map(model => [model.id, model]));
    const editingFallback = document.activeElement === ui.fallbackModel || ui.fallbackList.contains(document.activeElement);
    if (!state.fallbackLoaded || (!state.fallbackDirty && !editingFallback && !state.savingFallback)) {
      state.fallback = Array.isArray(status.fallback?.models) ? status.fallback.models.filter(id => typeof id === 'string') : [];
      state.fallbackLoaded = true;
      renderFallback();
    } else {
      renderModelPicker();
    }
    renderProviders();
    renderControls();
  }

  async function refreshStatus(force = false) {
    if (state.refreshing && !force) return;
    const requestId = ++state.requestId;
    state.refreshing = true;
    renderControls();
    try {
      const status = await send({ action: 'GET_STATUS' });
      if (requestId === state.requestId) acceptStatus(status);
    } catch (error) {
      if (requestId !== state.requestId) return;
      state.available = false;
      text(ui.bridgeStatusBadge, 'Status unavailable');
      ui.bridgeStatusBadge.dataset.state = 'error';
      feedback(ui.statusNotice, messageOf(error, 'Unable to read extension status. Try Refresh.'), 'error');
      if (!state.status) ui.pairingSection.hidden = false;
      renderProviders();
    } finally {
      if (requestId === state.requestId) { state.refreshing = false; renderControls(); }
    }
  }

  ui.pairCode.addEventListener('input', renderControls);
  ui.pairForm.addEventListener('submit', async event => {
    event.preventDefault();
    const code = ui.pairCode.value.trim();
    if (state.pairing || !code) return;
    state.pairing = true;
    renderControls();
    feedback(ui.pairFeedback, 'Pairing with the local bridge…', 'pending');
    try {
      await send({ action: 'PAIR', code });
      ui.pairCode.value = '';
      feedback(ui.pairFeedback, 'Browser paired.', 'success');
      feedback(ui.actionFeedback, 'Browser paired. Choose your provider connections below.', 'success');
      await refreshStatus(true);
    } catch (error) {
      feedback(ui.pairFeedback, messageOf(error), 'error');
    } finally {
      state.pairing = false;
      renderControls();
      if (state.status?.paired) {
        const connection = [...state.views.values()].find(view => !view.select.disabled)?.select;
        (connection || ui.refreshBtn).focus();
      } else ui.pairCode.focus();
    }
  });

  ui.syncAllBtn.addEventListener('click', async () => {
    if (ui.syncAllBtn.disabled) return;
    state.syncingAll = true;
    renderProviders();
    renderControls();
    feedback(ui.actionFeedback, 'Syncing mapped browser sessions…', 'pending');
    try {
      await send({ action: 'SYNC_ALL' });
      feedback(ui.actionFeedback, 'Sync request completed. Check each provider’s status.', 'success');
    } catch (error) {
      feedback(ui.actionFeedback, messageOf(error), 'error');
    } finally {
      state.syncingAll = false;
      await refreshStatus(true);
      renderProviders();
      renderControls();
    }
  });

  ui.fallbackModel.addEventListener('change', renderControls);
  ui.fallbackModel.addEventListener('blur', () => { renderModelPicker(); renderControls(); });
  ui.addModelBtn.addEventListener('click', () => {
    if (ui.addModelBtn.disabled) return;
    state.fallback.push(ui.fallbackModel.value);
    state.fallbackDirty = true;
    ui.fallbackModel.value = '';
    renderFallback();
    feedback(ui.fallbackFeedback, 'Model added. Save to apply this order.');
    if (!ui.fallbackModel.disabled) ui.fallbackModel.focus();
    else ui.saveFallbackBtn.focus();
  });

  ui.saveFallbackBtn.addEventListener('click', async () => {
    if (ui.saveFallbackBtn.disabled) return;
    state.savingFallback = true;
    const models = [...state.fallback];
    renderFallback();
    feedback(ui.fallbackFeedback, 'Saving fallback order…', 'pending');
    try {
      await send({ action: 'SAVE_FALLBACK', models });
      state.fallbackDirty = false;
      if (state.status) state.status.fallback = { name: 'browser-sessions', models, saved: true };
      feedback(ui.fallbackFeedback, 'Saved as browser-sessions. Your OmniRoute API key stays the same.', 'success');
    } catch (error) {
      feedback(ui.fallbackFeedback, messageOf(error), 'error');
    } finally {
      state.savingFallback = false;
      await refreshStatus(true);
      renderFallback();
    }
  });

  ui.refreshBtn.addEventListener('click', () => refreshStatus());
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshStatus(); });
  const refreshTimer = setInterval(() => {
    if (!document.hidden && state.status?.paired) refreshStatus();
  }, 5000);
  window.addEventListener('pagehide', () => clearInterval(refreshTimer), { once: true });
  refreshStatus();
});
