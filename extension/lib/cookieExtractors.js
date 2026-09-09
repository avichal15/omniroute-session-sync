/** Provider contracts shared by Chrome and the bridge. Never log extracted values. */
export const PROVIDERS = Object.freeze({
  'chatgpt-web': { name: 'ChatGPT Web', url: 'https://chatgpt.com/', domains: ['chatgpt.com', 'openai.com'] },
  'gemini-web': { name: 'Gemini Web', url: 'https://gemini.google.com/', domains: ['google.com'] },
  'zai-web': { name: 'Z.ai Web', url: 'https://chat.z.ai/', domains: ['z.ai'] },
  'qwen-web': { name: 'Qwen Web', url: 'https://chat.qwen.ai/', domains: ['qwen.ai'] },
  'grok-web': { name: 'Grok Web', url: 'https://grok.com/', domains: ['grok.com'] },
  'deepseek-web': { name: 'DeepSeek Web', url: 'https://chat.deepseek.com/', domains: ['deepseek.com'] },
});
const AUTH_NAMES = {
  'gemini-web': ['__Secure-1PSID', '__Secure-1PSIDTS', '__Secure-1PSIDCC', '__Secure-1PAPISID'],
  'zai-web': ['token'],
  'qwen-web': ['token', 'tongyi_sso_ticket', 'cna', 'ssxmod_itna', 'ssxmod_itna2'],
  'grok-web': ['sso', 'sso-rw', 'cf_clearance', '__cf_bm'],
  'deepseek-web': ['userToken', 'token'],
};
export function matchCookieProvider(domain, name) {
  const host = String(domain).replace(/^\./, '').toLowerCase();
  for (const [provider, meta] of Object.entries(PROVIDERS)) {
    if (!meta.domains.some(d => host === d || host.endsWith('.' + d))) continue;
    const relevant = provider === 'chatgpt-web'
      ? /^__Secure-next-auth\.session-token(?:\.\d+)?$/.test(name) : AUTH_NAMES[provider].includes(name);
    return relevant ? provider : null;
  }
  return null;
}
function cookieMap(cookies) {
  const map = new Map();
  for (const c of cookies) if (!map.has(c.name) && typeof c.value === 'string') map.set(c.name, c.value);
  return map;
}
function header(map, names = [...map.keys()]) {
  return [...new Set(names)].sort().filter(name => map.get(name)).map(name => `${name}=${map.get(name)}`).join('; ');
}
function sessionToken(map) {
  const chunks = [...map.entries()].filter(([name]) => /^__Secure-next-auth\.session-token\.\d+$/.test(name))
    .map(([name, value]) => ({ index: Number(name.split('.').at(-1)), value })).sort((a, b) => a.index - b.index);
  if (chunks.length) {
    if (chunks.some((chunk, index) => chunk.index !== index || !chunk.value)) return '';
    return chunks.map(chunk => chunk.value).join('');
  }
  return map.get('__Secure-next-auth.session-token') || '';
}
export function validCredential(provider, value) {
  if (!Object.hasOwn(PROVIDERS, provider) || typeof value !== 'string' || !value.trim()
      || value.length > 65536 || /[\r\n\0]/.test(value) || value.startsWith('enc:v1:')) return false;
  const fields = new Map(value.split(';').map(pair => {
    const index = pair.indexOf('=');
    return index < 0 ? ['', ''] : [pair.slice(0, index).trim(), pair.slice(index + 1).trim()];
  }));
  if (provider === 'chatgpt-web') return !/[;\s]/.test(value);
  if (provider === 'deepseek-web') {
    try { const parsed = JSON.parse(value); return typeof parsed?.value === 'string' && Boolean(parsed.value.trim()); }
    catch { return !/[;=\s]/.test(value); }
  }
  const required = { 'gemini-web': ['__Secure-1PSID'], 'zai-web': ['token'],
    'qwen-web': ['token', 'tongyi_sso_ticket'], 'grok-web': ['sso'] }[provider];
  return required.some(name => Boolean(fields.get(name)));
}
export async function extractForProvider(provider, readCookies = url => chrome.cookies.getAll({ url })) {
  const meta = PROVIDERS[provider];
  if (!meta) throw new Error('Unsupported browser provider');
  const cookies = await readCookies(meta.url);
  const map = cookieMap(cookies);
  let cookieValue = '';
  if (provider === 'chatgpt-web') cookieValue = sessionToken(map);
  else if (provider === 'deepseek-web') cookieValue = map.get('userToken') || map.get('token') || '';
  else if (provider === 'qwen-web') cookieValue = header(map);
  else cookieValue = header(map, AUTH_NAMES[provider]);
  const hasCredentials = validCredential(provider, cookieValue);
  return { provider, name: meta.name, hasCredentials, cookieValue: hasCredentials ? cookieValue : '', cookieCount: cookies.length };
}
