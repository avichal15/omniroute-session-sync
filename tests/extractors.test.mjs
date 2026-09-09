import test from 'node:test';
import assert from 'node:assert/strict';
import { extractForProvider, matchCookieProvider, validCredential } from '../extension/lib/cookieExtractors.js';

const jar = entries => async url => entries[url] ?? [];
test('ChatGPT reconstructs all ordered chunks and rejects incomplete rotations', async () => {
  const cookies = [3, 1, 0, 2].map(i => ({name:`__Secure-next-auth.session-token.${i}`,value:String(i)}));
  const full = await extractForProvider('chatgpt-web', jar({'https://chatgpt.com/':cookies}));
  assert.equal(full.cookieValue, '0123');
  const partial = await extractForProvider('chatgpt-web', jar({'https://chatgpt.com/':cookies.filter(c=>!c.name.endsWith('.1'))}));
  assert.equal(partial.hasCredentials, false);
});
test('analytics-only DeepSeek and Qwen sessions cannot overwrite credentials', async () => {
  for (const [provider,url] of [['deepseek-web','https://chat.deepseek.com/'],['qwen-web','https://chat.qwen.ai/']]) {
    const result = await extractForProvider(provider, jar({[url]:[{name:'_ga',value:'analytics'}]}));
    assert.equal(result.hasCredentials, false);
    assert.equal(result.cookieValue, '');
  }
});
test('Qwen sends one canonical cookie header without duplicate parent cookies', async () => {
  const result=await extractForProvider('qwen-web',jar({'https://chat.qwen.ai/':[
    {name:'token',value:'auth',domain:'.qwen.ai',path:'/'},
    {name:'cna',value:'waf',domain:'.qwen.ai',path:'/'},
  ]}));
  assert.equal(result.cookieValue,'cna=waf; token=auth');
});
test('event matching uses domain boundaries and relevant supporting cookies',()=>{
  assert.equal(matchCookieProvider('.chatgpt.com','__Secure-next-auth.session-token.7'),'chatgpt-web');
  assert.equal(matchCookieProvider('notchatgpt.com','__Secure-next-auth.session-token'),null);
  assert.equal(matchCookieProvider('.google.com','__Secure-1PSIDTS'),'gemini-web');
  assert.equal(matchCookieProvider('grok.com','cf_clearance'),'grok-web');
  assert.equal(matchCookieProvider('google.com','NID'),null);
});
test('bridge credential validation rejects empty, newline and non-auth cookie payloads',()=>{
  assert.equal(validCredential('chatgpt-web','synthetic-session'),true);
  assert.equal(validCredential('qwen-web','_ga=analytics'),false);
  assert.equal(validCredential('zai-web','token=auth\r\nInjected: x'),false);
  assert.equal(validCredential('deepseek-web','_ga=analytics'),false);
  assert.equal(validCredential('openai','synthetic-api-key'),false);
});
