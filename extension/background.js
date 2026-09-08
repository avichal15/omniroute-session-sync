/**
 * OmniRoute Session Sync - Background Service Worker
 * Standalone, zero-import bundle with strict cookie filtering, deduplication, and quiet offline handling.
 */

const BRIDGE_URL = 'http://127.0.0.1:20129';
let syncDebounceTimeout = null;
let lastSyncedCache = {};

// Target cookie filters - ONLY these cookies trigger sync events.
// This prevents thousands of analytics/search cookies (NID, _ga, 1P_JAR) from spamming syncs.
const TARGET_COOKIE_FILTERS = {
  'chatgpt-web': (name) => name.startsWith('__Secure-next-auth.session-token'),
  'gemini-web': (name) => name === '__Secure-1PSID' || name === '__Secure-1PSIDTS',
  'zai-web': (name) => name === 'token',
  'qwen-web': (name) => name === 'token' || name === 'tongyi_sso_ticket',
  'grok-web': (name) => name === 'sso' || name === 'sso-rw',
  'deepseek-web': (name) => name === 'userToken' || name === 'token'
};

const DOMAIN_TO_PROVIDER = {
  'chatgpt.com': 'chatgpt-web',
  'openai.com': 'chatgpt-web',
  'gemini.google.com': 'gemini-web',
  'google.com': 'gemini-web',
  'chat.z.ai': 'zai-web',
  'z.ai': 'zai-web',
  'chat.qwen.ai': 'qwen-web',
  'qwen.ai': 'qwen-web',
  'grok.com': 'grok-web',
  'chat.deepseek.com': 'deepseek-web'
};

// --- Cookie Extraction Functions ---

async function extractAllCookiesForDomain(url) {
  try {
    return await chrome.cookies.getAll({ url });
  } catch (err) {
    return [];
  }
}

function formatCookieString(cookies) {
  return cookies.map(c => `${c.name}=${c.value}`).join('; ');
}

function getCookieMap(cookies) {
  const map = {};
  for (const c of cookies) {
    map[c.name] = c.value;
  }
  return map;
}

// ChatGPT Web
async function extractChatGPT() {
  const cookies = await extractAllCookiesForDomain('https://chatgpt.com');
  const map = getCookieMap(cookies);

  const chunk0 = map['__Secure-next-auth.session-token.0'];
  const chunk1 = map['__Secure-next-auth.session-token.1'];
  const chunk2 = map['__Secure-next-auth.session-token.2'];
  const single = map['__Secure-next-auth.session-token'];

  let formattedValue = '';
  let tokenType = '';

  if (chunk0 && chunk1) {
    formattedValue = chunk0 + chunk1 + (chunk2 || '');
    tokenType = 'chunked-concatenated';
  } else if (single) {
    formattedValue = single;
    tokenType = 'single-token';
  } else {
    const relevant = cookies.filter(c => c.name.includes('session-token'));
    if (relevant.length > 0) {
      formattedValue = formatCookieString(relevant);
      tokenType = 'cookie-header';
    }
  }

  return {
    provider: 'chatgpt-web',
    name: 'ChatGPT Web',
    domain: 'chatgpt.com',
    hasCredentials: Boolean(formattedValue),
    cookieValue: formattedValue,
    tokenType,
    cookieCount: cookies.length
  };
}

// Gemini Web
async function extractGemini() {
  const cookies = await extractAllCookiesForDomain('https://gemini.google.com');
  const googleCookies = await extractAllCookiesForDomain('https://google.com');
  const allCookies = [...cookies, ...googleCookies];
  const map = getCookieMap(allCookies);

  const psid = map['__Secure-1PSID'];
  const psidts = map['__Secure-1PSIDTS'];
  const psidcc = map['__Secure-1PSIDCC'];
  const papisid = map['__Secure-1PAPISID'];

  let formattedValue = '';
  if (psid) {
    const parts = [`__Secure-1PSID=${psid}`];
    if (psidts) parts.push(`__Secure-1PSIDTS=${psidts}`);
    if (psidcc) parts.push(`__Secure-1PSIDCC=${psidcc}`);
    if (papisid) parts.push(`__Secure-1PAPISID=${papisid}`);
    formattedValue = parts.join('; ');
  }

  return {
    provider: 'gemini-web',
    name: 'Gemini Web',
    domain: 'gemini.google.com',
    hasCredentials: Boolean(psid),
    cookieValue: formattedValue,
    hasTimestampTicket: Boolean(psidts),
    cookieCount: allCookies.length
  };
}

// Z.ai Web
async function extractZai() {
  const cookies = await extractAllCookiesForDomain('https://chat.z.ai');
  const rootCookies = await extractAllCookiesForDomain('https://z.ai');
  const allCookies = [...cookies, ...rootCookies];
  const map = getCookieMap(allCookies);

  const token = map['token'];
  let formattedValue = '';

  if (token) {
    formattedValue = `token=${token}`;
  }

  return {
    provider: 'zai-web',
    name: 'Z.ai Web',
    domain: 'chat.z.ai',
    hasCredentials: Boolean(token),
    cookieValue: formattedValue,
    hasToken: Boolean(token),
    cookieCount: allCookies.length
  };
}

// Qwen Web
async function extractQwen() {
  const cookies = await extractAllCookiesForDomain('https://chat.qwen.ai');
  const rootCookies = await extractAllCookiesForDomain('https://qwen.ai');
  const allCookies = [...cookies, ...rootCookies];
  const map = getCookieMap(allCookies);

  let formattedValue = '';
  if (allCookies.length > 0) {
    formattedValue = formatCookieString(allCookies);
  }

  return {
    provider: 'qwen-web',
    name: 'Qwen Web',
    domain: 'chat.qwen.ai',
    hasCredentials: Boolean(formattedValue && (map['token'] || map['tongyi_sso_ticket'])),
    cookieValue: formattedValue,
    hasToken: Boolean(map['token'] || map['tongyi_sso_ticket']),
    cookieCount: allCookies.length
  };
}

// Grok Web
async function extractGrok() {
  const cookies = await extractAllCookiesForDomain('https://grok.com');
  const map = getCookieMap(cookies);

  const sso = map['sso'];
  const ssoRw = map['sso-rw'];
  const cfClearance = map['cf_clearance'];
  const cfBm = map['__cf_bm'];

  let formattedValue = '';
  if (sso) {
    const parts = [`sso=${sso}`];
    if (ssoRw) parts.push(`sso-rw=${ssoRw}`);
    if (cfClearance) parts.push(`cf_clearance=${cfClearance}`);
    if (cfBm) parts.push(`__cf_bm=${cfBm}`);
    formattedValue = parts.join('; ');
  }

  return {
    provider: 'grok-web',
    name: 'Grok Web',
    domain: 'grok.com',
    hasCredentials: Boolean(sso),
    cookieValue: formattedValue,
    cookieCount: cookies.length
  };
}

// DeepSeek Web
async function extractDeepSeek() {
  const cookies = await extractAllCookiesForDomain('https://chat.deepseek.com');
  const map = getCookieMap(cookies);
  const userToken = map['userToken'] || map['token'];
  let formattedValue = userToken || (cookies.length > 0 ? formatCookieString(cookies) : '');

  return {
    provider: 'deepseek-web',
    name: 'DeepSeek Web',
    domain: 'chat.deepseek.com',
    hasCredentials: Boolean(formattedValue),
    cookieValue: formattedValue,
    cookieCount: cookies.length
  };
}

const EXTRACTORS = {
  'chatgpt-web': extractChatGPT,
  'gemini-web': extractGemini,
  'zai-web': extractZai,
  'qwen-web': extractQwen,
  'grok-web': extractGrok,
  'deepseek-web': extractDeepSeek
};

async function extractAllConfigured() {
  const results = {};
  for (const [provider, extractor] of Object.entries(EXTRACTORS)) {
    try {
      results[provider] = await extractor();
    } catch (err) {
      results[provider] = { provider, hasCredentials: false, error: err.message };
    }
  }
  return results;
}

// --- Bridge Communication & Sync ---

let isBridgeOffline = false;
let lastBridgeCheckTime = 0;

async function checkBridgeStatus() {
  const now = Date.now();
  if (isBridgeOffline && (now - lastBridgeCheckTime < 20000)) {
    // If bridge was recently confirmed offline, avoid spamming requests
    return false;
  }
  lastBridgeCheckTime = now;
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 2000);
    const res = await fetch(`${BRIDGE_URL}/health`, {
      method: 'GET',
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    isBridgeOffline = !res.ok;
    return res.ok;
  } catch {
    isBridgeOffline = true;
    return false;
  }
}

async function sendToBridge(endpoint, data = {}) {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(`${BRIDGE_URL}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    isBridgeOffline = false;
    return await res.json();
  } catch (err) {
    isBridgeOffline = true;
    return { success: false, error: 'Bridge offline' };
  }
}

async function syncProvider(provider, force = false) {
  const extractor = EXTRACTORS[provider];
  if (!extractor) return { success: false, error: 'No extractor for ' + provider };

  const extracted = await extractor();
  if (!extracted.hasCredentials || !extracted.cookieValue) {
    return { success: false, error: 'No active session found for ' + provider };
  }

  // Deduplication check: if the formatted cookie has not changed, skip sync!
  if (!force && lastSyncedCache[provider] === extracted.cookieValue) {
    return { success: true, skipped: true, message: 'Cookie unchanged' };
  }

  const isOnline = await checkBridgeStatus();
  if (!isOnline) {
    return { success: false, error: 'Bridge offline' };
  }

  const res = await sendToBridge('/api/sync', {
    provider,
    cookie: extracted.cookieValue,
    source: 'chrome-extension-auto'
  });

  if (res && res.success) {
    lastSyncedCache[provider] = extracted.cookieValue;
  }
  return res;
}

async function syncAllProviders() {
  const isOnline = await checkBridgeStatus();
  if (!isOnline) {
    return { success: false, error: 'Bridge offline - start scripts/start-bridge.bat' };
  }

  const extractedAll = await extractAllConfigured();
  const updates = [];

  for (const [provider, item] of Object.entries(extractedAll)) {
    if (item.hasCredentials && item.cookieValue) {
      updates.push({
        provider,
        cookie: item.cookieValue,
        source: 'chrome-extension-full-sync'
      });
      lastSyncedCache[provider] = item.cookieValue;
    }
  }

  if (updates.length === 0) {
    return { success: true, count: 0, message: 'No active chat sessions found.' };
  }

  const res = await sendToBridge('/api/sync/bulk', { updates });
  await chrome.storage.local.set({ lastSyncTime: new Date().toISOString() });
  return res;
}

// --- Event Listeners ---

// Filtered cookie changes: only fires when relevant auth cookies change
chrome.cookies.onChanged.addListener((changeInfo) => {
  const domain = changeInfo.cookie.domain.replace(/^\./, '');
  const cookieName = changeInfo.cookie.name;

  let matchedProvider = null;
  for (const [targetDomain, provider] of Object.entries(DOMAIN_TO_PROVIDER)) {
    if (domain.includes(targetDomain)) {
      matchedProvider = provider;
      break;
    }
  }

  if (!matchedProvider) return;

  // Strict cookie filter check
  const filter = TARGET_COOKIE_FILTERS[matchedProvider];
  if (filter && !filter(cookieName)) {
    // Irrelevant cookie changed (e.g. NID, _ga) -> ignore immediately!
    return;
  }

  if (syncDebounceTimeout) clearTimeout(syncDebounceTimeout);
  syncDebounceTimeout = setTimeout(async () => {
    await syncProvider(matchedProvider);
  }, 3000);
});

// Periodic alarm setup
chrome.alarms.get('omniroute-periodic-sync', (alarm) => {
  if (!alarm) {
    chrome.alarms.create('omniroute-periodic-sync', { periodInMinutes: 10 });
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'omniroute-periodic-sync') {
    syncAllProviders().catch(() => {});
  }
});

// Message listener for Popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'SYNC_ALL') {
    syncAllProviders()
      .then(res => sendResponse(res))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (request.action === 'SYNC_ONE') {
    syncProvider(request.provider, true)
      .then(res => sendResponse(res))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (request.action === 'GET_STATUS') {
    extractAllConfigured()
      .then(async (extracted) => {
        try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 2000);
          const res = await fetch(`${BRIDGE_URL}/api/status`, { signal: controller.signal });
          clearTimeout(timeoutId);
          const bridgeStatus = await res.json();
          sendResponse({ success: true, extracted, bridge: bridgeStatus });
        } catch {
          sendResponse({ success: true, extracted, bridge: { success: false, error: 'offline' } });
        }
      })
      .catch(err => {
        sendResponse({ success: false, error: err.message });
      });
    return true;
  }

  sendResponse({ success: false, error: 'Unknown action' });
  return false;
});
