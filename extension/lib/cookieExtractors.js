/**
 * Tailored Cookie Extractors & Formatters for OmniRoute Web Providers
 */

export async function extractAllCookiesForDomain(url) {
  try {
    return await chrome.cookies.getAll({ url });
  } catch (err) {
    console.error('Error fetching cookies for ' + url, err);
    return [];
  }
}

export function formatCookieString(cookies) {
  return cookies.map(c => `${c.name}=${c.value}`).join('; ');
}

export function getCookieMap(cookies) {
  const map = {};
  for (const c of cookies) {
    map[c.name] = c.value;
  }
  return map;
}

// 1. ChatGPT Web
export async function extractChatGPT() {
  const cookies = await extractAllCookiesForDomain('https://chatgpt.com');
  const map = getCookieMap(cookies);

  // Check for chunked NextAuth session tokens
  const chunk0 = map['__Secure-next-auth.session-token.0'];
  const chunk1 = map['__Secure-next-auth.session-token.1'];
  const chunk2 = map['__Secure-next-auth.session-token.2'];
  const single = map['__Secure-next-auth.session-token'];

  let formattedValue = '';
  let tokenType = '';

  if (chunk0 && chunk1) {
    // Concatenate chunks back-to-back
    formattedValue = chunk0 + chunk1 + (chunk2 || '');
    tokenType = 'chunked-concatenated';
  } else if (single) {
    formattedValue = single;
    tokenType = 'single-token';
  } else {
    // Check if full Cookie header has valid tokens
    const relevant = cookies.filter(c => c.name.includes('session-token') || c.name.includes('cf_clearance') || c.name.includes('oai-'));
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

// 2. Gemini Web
export async function extractGemini() {
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

// 3. Z.ai Web
export async function extractZai() {
  const cookies = await extractAllCookiesForDomain('https://chat.z.ai');
  const rootCookies = await extractAllCookiesForDomain('https://z.ai');
  const allCookies = [...cookies, ...rootCookies];
  const map = getCookieMap(allCookies);

  const token = map['token'];
  let formattedValue = '';

  if (token) {
    // If it's a JWT, pass token or full header
    formattedValue = `token=${token}`;
  } else if (allCookies.length > 0) {
    formattedValue = formatCookieString(allCookies);
  }

  return {
    provider: 'zai-web',
    name: 'Z.ai Web',
    domain: 'chat.z.ai',
    hasCredentials: Boolean(token || formattedValue),
    cookieValue: formattedValue,
    hasToken: Boolean(token),
    cookieCount: allCookies.length
  };
}

// 4. Qwen Web
export async function extractQwen() {
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
    hasCredentials: Boolean(formattedValue),
    cookieValue: formattedValue,
    hasToken: Boolean(map['token'] || map['tongyi_sso_ticket']),
    cookieCount: allCookies.length
  };
}

// 5. Grok Web
export async function extractGrok() {
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

// 6. DeepSeek Web
export async function extractDeepSeek() {
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

// Master Extractor Map
export const EXTRACTORS = {
  'chatgpt-web': extractChatGPT,
  'gemini-web': extractGemini,
  'zai-web': extractZai,
  'qwen-web': extractQwen,
  'grok-web': extractGrok,
  'deepseek-web': extractDeepSeek
};

export async function extractAllConfigured() {
  const results = {};
  for (const [provider, extractor] of Object.entries(EXTRACTORS)) {
    try {
      results[provider] = await extractor();
    } catch (err) {
      console.error(`Failed to extract for ${provider}:`, err);
      results[provider] = { provider, hasCredentials: false, error: err.message };
    }
  }
  return results;
}
