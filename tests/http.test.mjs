import test from 'node:test';
import assert from 'node:assert/strict';
import { createBridge } from '../bridge/server.mjs';
import { SyncService } from '../bridge/syncService.mjs';

async function fixture(t){
  const state={ownerToken:'o'.repeat(64),client:{token:'c'.repeat(64),origin:'chrome-extension://'+'a'.repeat(32)},mappings:{'chatgpt-web':'one'},statuses:{}};
  const writes=[];const gateway={listConnections:async()=>[{id:'one',provider:'chatgpt-web',name:'Account',authType:'apikey',isActive:true}],
    listModels:async()=>[],updateCredential:async(id,cookie)=>writes.push({id,cookie}),testConnection:async()=>({valid:true})};
  const persist=async()=>{};const service=new SyncService({gateway,state,persist});
  const server=createBridge({gateway,service,state,persist});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(()=>{server.closeAllConnections();server.close()});
  const base=`http://127.0.0.1:${server.address().port}`;
  const call=(path,body,headers={})=>fetch(base+path,{method:body===undefined?'GET':'POST',
    headers:{Authorization:'Bearer '+state.client.token,Origin:state.client.origin,...(body===undefined?{}:{'Content-Type':'application/json'}),...headers},
    body:body===undefined?undefined:JSON.stringify(body)});
  return {state,gateway,writes,call,base};
}
test('unauthenticated and foreign-origin writes are rejected without side effects',async t=>{
  const f=await fixture(t);const data={provider:'chatgpt-web',connectionId:'one',cookie:'synthetic',revision:1};
  assert.equal((await f.call('/api/sync',data,{Authorization:''})).status,401);
  assert.equal((await f.call('/api/sync',data,{Origin:'https://untrusted.example'})).status,403);
  assert.equal((await f.call('/api/sync',data,{'Content-Type':'text/plain'})).status,415);
  assert.equal(f.writes.length,0);
});
test('authorized updates acknowledge saved credentials and status contains no token',async t=>{
  const f=await fixture(t);const r=await f.call('/api/sync',{provider:'chatgpt-web',connectionId:'one',cookie:'secret-synthetic',revision:1});
  assert.equal(r.status,200);assert.equal((await r.json()).success,true);
  const status=await(await f.call('/api/status')).text();assert.ok(!status.includes('secret-synthetic'));assert.ok(!status.includes(f.state.client.token));
});
test('readiness fails when OmniRoute is unavailable',async t=>{
  const f=await fixture(t);f.gateway.listConnections=async()=>{throw new Error('offline')};
  const r=await fetch(f.base+'/health');assert.equal(r.status,503);assert.equal((await r.json()).ready,false);
});
test('pairing requires the owner-issued one-time code and clears prior profile mappings',async t=>{
  const f=await fixture(t);const owner={Authorization:'Bearer '+f.state.ownerToken,Origin:''};
  const issued=await(await f.call('/api/pairing-code',{},owner)).json();assert.ok(issued.code);
  const oldToken=f.state.client.token;
  const paired=await(await f.call('/api/pair',{code:issued.code},{Authorization:''})).json();
  assert.equal(paired.success,true);assert.notEqual(paired.token,oldToken);assert.deepEqual(f.state.mappings,{});
  assert.equal((await f.call('/api/pair',{code:issued.code},{Authorization:''})).status,401);
});
test('malformed JSON and excessive bodies fail with bounded errors',async t=>{
  const f=await fixture(t);const headers={Authorization:'Bearer '+f.state.client.token,Origin:f.state.client.origin,'Content-Type':'application/json'};
  const malformed=await fetch(f.base+'/api/sync',{method:'POST',headers,body:'{'});assert.equal(malformed.status,400);
  const large=await f.call('/api/sync',{cookie:'x'.repeat(600000)});assert.equal(large.status,413);
});
test('failed syncs remain failures in bulk responses',async t=>{
  const f=await fixture(t);const r=await f.call('/api/sync/bulk',{updates:[{provider:'chatgpt-web',connectionId:'wrong',cookie:'synthetic',revision:1}]});
  const b=await r.json();assert.equal(b.success,false);assert.equal(b.results[0].success,false);
});
