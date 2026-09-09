import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { OmniClient } from '../bridge/omniClient.mjs';

async function fixture(t,handler,cloudEnabled=false){
  const server=http.createServer((req,res)=>{
    if(req.url==='/api/settings'){res.setHeader('Content-Type','application/json');return res.end(JSON.stringify({cloudEnabled}));}
    return handler(req,res);
  });await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(()=>{server.closeAllConnections();server.close()});
  return new OmniClient({baseUrl:`http://127.0.0.1:${server.address().port}`,headers:()=>({'Authorization':'Bearer synthetic-management'})});
}
test('gateway metadata strips all secrets and filters to browser providers',async t=>{
  const client=await fixture(t,(req,res)=>{
    assert.equal(req.headers.authorization,'Bearer synthetic-management');res.setHeader('Content-Type','application/json');
    res.end(JSON.stringify({connections:[{id:'a',provider:'chatgpt-web',authType:'apikey',isActive:true,name:'A',apiKey:'do-not-expose',providerSpecificData:{cookie:'do-not-expose'}},
      {id:'paid',provider:'openai',isActive:true}]}));
  });
  const rows=await client.listConnections();assert.equal(rows.length,1);assert.ok(!JSON.stringify(rows).includes('do-not-expose'));
});
test('credential update uses the supported PUT for exactly one connection',async t=>{
  let request;
  const client=await fixture(t,async(req,res)=>{
    let body='';for await(const chunk of req)body+=chunk;
    request={method:req.method,url:req.url,body:JSON.parse(body)};
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify({connection:{id:'a'}}));
  });
  await client.updateCredential('a','synthetic-session');
  assert.equal(request.method,'PUT');assert.equal(request.url,'/api/providers/a');
  assert.equal(request.body.apiKey,'synthetic-session');assert.equal(request.body.testStatus,'unknown');
});
test('upstream error bodies cannot reflect session cookies back to extension',async t=>{
  const client=await fixture(t,(_req,res)=>{res.writeHead(500,{'Content-Type':'application/json'});res.end('{"error":"synthetic-secret-cookie"}')});
  await assert.rejects(client.updateCredential('a','synthetic-secret-cookie'),e=>!e.message.includes('synthetic-secret-cookie')&&e.code==='GATEWAY_ERROR');
});
test('catalog uses configured active browser providers and fallback does not replace unrelated route',async t=>{
  const client=await fixture(t,(req,res)=>{
    res.setHeader('Content-Type','application/json');
    if(req.url.includes('builder'))res.end(JSON.stringify({providers:[
      {providerId:'chatgpt-web',activeConnectionCount:1,models:[{id:'model',qualifiedModel:'chatgpt-web/model',name:'Model'}]},
      {providerId:'openai',activeConnectionCount:1,models:[{id:'paid',qualifiedModel:'openai/paid'}]}]}));
    else res.end(JSON.stringify({combos:[{id:'unrelated',name:'browser-sessions',description:'User route'}]}));
  });
  assert.deepEqual((await client.listModels()).map(m=>m.id),['chatgpt-web/model']);
  await assert.rejects(client.saveFallback(['chatgpt-web/model'],{}),/already exists/i);
});
test('local-only gateway refuses credential updates when cloud sync is enabled',async t=>{
  let writes=0;const client=await fixture(t,(_req,res)=>{writes++;res.end('{}')},true);
  await assert.rejects(client.updateCredential('a','synthetic-session'),/cloud sync/i);
  assert.equal(writes,0);
});
