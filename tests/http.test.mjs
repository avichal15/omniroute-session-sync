import test from 'node:test';
import assert from 'node:assert/strict';
import { createBridge } from '../bridge/server.mjs';
import { SyncService } from '../bridge/syncService.mjs';

function deferred(){
  let resolve;let reject;const promise=new Promise((done,fail)=>{resolve=done;reject=fail});
  return {promise,resolve,reject};
}

async function fixture(t,options={}){
  const state={ownerToken:'o'.repeat(64),client:{token:'c'.repeat(64),origin:'chrome-extension://'+'a'.repeat(32)},mappings:{'chatgpt-web':'one'},statuses:{}};
  const writes=[];const gateway={listConnections:async()=>[{id:'one',provider:'chatgpt-web',name:'Account',authType:'apikey',isActive:true}],
    listModels:async()=>[],updateCredential:async(id,cookie)=>writes.push({id,cookie}),testConnection:async()=>({valid:true})};
  const persist=options.persist || (async()=>{});const service=new SyncService({gateway,state,persist});
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
test('health stays locally available when OmniRoute is temporarily unavailable',async t=>{
  const f=await fixture(t);f.gateway.listConnections=async()=>{throw new Error('offline')};
  const r=await fetch(f.base+'/health');const health=await r.json();
  assert.equal(r.status,200);assert.equal(health.alive,true);assert.equal(health.ready,false);
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

test('non-ASCII invalid secrets are rejected without throwing a server error',async t=>{
  const f=await fixture(t);
  assert.equal((await f.call('/api/status',undefined,{Authorization:'Bearer '+'é'.repeat(64)})).status,401);
  await f.call('/api/pairing-code',{}, {Authorization:'Bearer '+f.state.ownerToken,Origin:''});
  assert.equal((await f.call('/api/pair',{code:'é'.repeat(12)},{Authorization:''})).status,401);
  assert.equal((await f.call('/api/status')).status,200);
});

test('pairing cannot overtake an active old-profile write and the busy code remains usable',{timeout:3000},async t=>{
  const f=await fixture(t);const started=deferred();const release=deferred();
  t.after(()=>release.resolve());
  const issued=await(await f.call('/api/pairing-code',{}, {Authorization:'Bearer '+f.state.ownerToken,Origin:''})).json();
  const oldToken=f.state.client.token;
  f.gateway.updateCredential=async(id,cookie)=>{started.resolve();await release.promise;f.writes.push({id,cookie})};
  const syncing=f.call('/api/sync',{provider:'chatgpt-web',connectionId:'one',cookie:'synthetic-old-profile',revision:1});
  void syncing.catch(()=>{});
  await started.promise;
  const nextProfile={Authorization:'',Origin:'chrome-extension://'+'b'.repeat(32)};
  const busy=await f.call('/api/pair',{code:issued.code},nextProfile);
  assert.equal(busy.status,409);assert.equal((await busy.json()).error.code,'BUSY');
  assert.equal(f.state.client.token,oldToken);assert.equal(f.writes.length,0);
  release.resolve();assert.equal((await syncing).status,200);assert.equal(f.writes.length,1);
  const paired=await f.call('/api/pair',{code:issued.code},nextProfile);
  assert.equal(paired.status,200);assert.deepEqual(f.state.mappings,{});assert.deepEqual(f.state.statuses,{});
  assert.equal((await f.call('/api/status',undefined,{Authorization:'Bearer '+oldToken})).status,401);
});

test('one pairing code permits at most one concurrent redemption and blocks protected admission',{timeout:3000},async t=>{
  const started=deferred();const release=deferred();let saves=0;
  t.after(()=>release.resolve());
  const f=await fixture(t,{persist:async()=>{started.resolve();if(++saves===2)release.resolve();await release.promise}});
  const issued=await(await f.call('/api/pairing-code',{}, {Authorization:'Bearer '+f.state.ownerToken,Origin:''})).json();
  const first=f.call('/api/pair',{code:issued.code},{Authorization:''});await started.promise;
  const blocked=await f.call('/api/status');
  const second=await f.call('/api/pair',{code:issued.code},{Authorization:''});
  release.resolve();const accepted=await first;
  assert.equal(blocked.status,409);assert.equal((await blocked.json()).error.code,'BUSY');
  assert.equal(accepted.status,200);assert.notEqual(second.status,200);assert.equal(saves,1);
  const result=await accepted.json();assert.equal(result.token,f.state.client.token);
  assert.equal((await f.call('/api/pair',{code:issued.code},{Authorization:''})).status,401);
});

test('failed pairing persistence preserves the previous profile and permits retry of the same code',async t=>{
  let saves=0;const f=await fixture(t,{persist:async()=>{if(++saves===1)throw new Error('storage unavailable')}});
  const previous=structuredClone(f.state);
  const issued=await(await f.call('/api/pairing-code',{}, {Authorization:'Bearer '+f.state.ownerToken,Origin:''})).json();
  assert.equal((await f.call('/api/pair',{code:issued.code},{Authorization:''})).status,500);
  assert.deepEqual(f.state,previous);
  assert.equal((await f.call('/api/status')).status,200);
  assert.equal((await f.call('/api/pair',{code:issued.code},{Authorization:''})).status,200);
  assert.notEqual(f.state.client.token,previous.client.token);
});

test('authenticated provider updates retain independent gateway concurrency',{timeout:3000},async t=>{
  const f=await fixture(t);const bothStarted=deferred();const release=deferred();let active=0;
  t.after(()=>release.resolve());f.state.mappings['gemini-web']='two';
  f.gateway.listConnections=async()=>[
    {id:'one',provider:'chatgpt-web',isActive:true,authType:'apikey'},
    {id:'two',provider:'gemini-web',isActive:true,authType:'apikey'}];
  f.gateway.updateCredential=async(id,cookie)=>{if(++active===2)bothStarted.resolve();await release.promise;f.writes.push({id,cookie});active--};
  const chat=f.call('/api/sync',{provider:'chatgpt-web',connectionId:'one',cookie:'synthetic-chat',revision:1});
  const gemini=f.call('/api/sync',{provider:'gemini-web',connectionId:'two',cookie:'__Secure-1PSID=synthetic-gemini',revision:1});
  await bothStarted.promise;assert.equal(active,2);release.resolve();
  assert.deepEqual((await Promise.all([chat,gemini])).map(response=>response.status),[200,200]);
  assert.deepEqual(new Set(f.writes.map(write=>write.id)),new Set(['one','two']));
});

test('management-token validation cannot leak an uncommitted token into a provider save',{timeout:3000},async t=>{
  let disk;const f=await fixture(t,{persist:async candidate=>{disk=structuredClone(candidate)}});
  f.state.managementToken='synthetic-old-management';
  const started=deferred();const release=deferred();t.after(()=>release.resolve());
  const list=f.gateway.listConnections;
  f.gateway.listConnections=async options=>{
    if(options?.headers){
      assert.equal(options.headers.Authorization,'Bearer synthetic-next-management');
      started.resolve();await release.promise;
    }
    return list();
  };
  const updating=f.call('/api/gateway-auth',{token:'synthetic-next-management'},
    {Authorization:'Bearer '+f.state.ownerToken,Origin:''});
  void updating.catch(()=>{});await started.promise;
  assert.equal(f.state.managementToken,'synthetic-old-management');
  assert.equal((await f.call('/api/mappings',{provider:'chatgpt-web',connectionId:null})).status,200);
  assert.equal(disk.managementToken,'synthetic-old-management');
  release.resolve();assert.equal((await updating).status,200);
  assert.equal(f.state.managementToken,'synthetic-next-management');
  assert.deepEqual(f.state.mappings,{});assert.deepEqual(disk,f.state);
});
