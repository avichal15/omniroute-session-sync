/**
 * OmniRoute Session Sync - Popup Script
 * Error-safe UI with checked runtime.lastError and clear offline indicators.
 */

const PROVIDER_NAMES = {
  'chatgpt-web': { name: 'ChatGPT Web', domain: 'chatgpt.com', icon: '🤖' },
  'gemini-web': { name: 'Gemini Web', domain: 'gemini.google.com', icon: '✨' },
  'zai-web': { name: 'Z.ai Web', domain: 'chat.z.ai', icon: '⚡' },
  'qwen-web': { name: 'Qwen Web', domain: 'chat.qwen.ai', icon: '🌐' },
  'grok-web': { name: 'Grok Web', domain: 'grok.com', icon: '🪐' },
  'deepseek-web': { name: 'DeepSeek Web', domain: 'chat.deepseek.com', icon: '🐋' }
};

document.addEventListener('DOMContentLoaded', async () => {
  const bridgeStatusBadge = document.getElementById('bridgeStatusBadge');
  const syncAllBtn = document.getElementById('syncAllBtn');
  const providersList = document.getElementById('providersList');
  const lastSyncLabel = document.getElementById('lastSyncLabel');

  try {
    const { lastSyncTime } = await chrome.storage.local.get(['lastSyncTime']);
    if (lastSyncTime) {
      lastSyncLabel.textContent = 'Last synced: ' + new Date(lastSyncTime).toLocaleTimeString();
    }
  } catch {}

  function refreshUI() {
    chrome.runtime.sendMessage({ action: 'GET_STATUS' }, (response) => {
      // Always verify runtime.lastError to avoid "Unchecked runtime.lastError" warnings in Chrome
      if (chrome.runtime.lastError || !response || !response.success) {
        bridgeStatusBadge.className = 'badge badge-offline';
        bridgeStatusBadge.textContent = 'BRIDGE OFFLINE';
        return;
      }

      const { extracted, bridge } = response;
      if (bridge && bridge.success) {
        bridgeStatusBadge.className = 'badge badge-online';
        bridgeStatusBadge.textContent = 'BRIDGE ONLINE';
      } else {
        bridgeStatusBadge.className = 'badge badge-offline';
        bridgeStatusBadge.textContent = 'BRIDGE OFFLINE';
      }

      providersList.innerHTML = '';

      for (const [key, meta] of Object.entries(PROVIDER_NAMES)) {
        const item = (extracted && extracted[key]) || {};
        const hasSession = Boolean(item.hasCredentials);

        const card = document.createElement('div');
        card.className = 'provider-card';

        const infoDiv = document.createElement('div');
        infoDiv.className = 'provider-info';

        const nameSpan = document.createElement('div');
        nameSpan.className = 'provider-name';
        nameSpan.textContent = `${meta.icon} ${meta.name}`;

        const statusSpan = document.createElement('div');
        statusSpan.className = 'provider-status';
        statusSpan.innerHTML = hasSession
          ? `<span class="status-dot active"></span> <span style="color: #10b981">Session Active</span>`
          : `<span class="status-dot missing"></span> <span style="color: #9aa0b4">Not Logged In</span>`;

        infoDiv.appendChild(nameSpan);
        infoDiv.appendChild(statusSpan);

        const btn = document.createElement('button');
        btn.className = 'btn btn-sync-small';
        btn.textContent = 'Sync';
        btn.disabled = !hasSession;
        btn.onclick = () => {
          btn.textContent = '...';
          chrome.runtime.sendMessage({ action: 'SYNC_ONE', provider: key }, (res) => {
            if (chrome.runtime.lastError) {
              btn.textContent = 'Failed';
              return;
            }
            if (res && res.success) {
              btn.textContent = '✓ Done';
            } else {
              btn.textContent = res && res.error === 'Bridge offline' ? 'Offline' : 'Error';
            }
            setTimeout(() => { refreshUI(); }, 1500);
          });
        };

        card.appendChild(infoDiv);
        card.appendChild(btn);
        providersList.appendChild(card);
      }
    });
  }

  syncAllBtn.addEventListener('click', () => {
    syncAllBtn.textContent = 'Syncing...';
    chrome.runtime.sendMessage({ action: 'SYNC_ALL' }, (res) => {
      if (chrome.runtime.lastError) {
        syncAllBtn.textContent = 'Bridge Offline';
      } else if (res && res.success) {
        syncAllBtn.textContent = '✓ Sync Complete!';
        lastSyncLabel.textContent = 'Last synced: ' + new Date().toLocaleTimeString();
      } else {
        syncAllBtn.textContent = res && res.error ? res.error : 'Sync Failed';
      }

      setTimeout(() => {
        syncAllBtn.innerHTML = '<span class="btn-icon">🔄</span> Sync All Active Sessions';
        refreshUI();
      }, 1500);
    });
  });

  refreshUI();
});
