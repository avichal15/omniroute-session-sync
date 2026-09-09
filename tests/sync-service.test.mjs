import test from 'node:test';
import assert from 'node:assert/strict';
import { SyncService } from '../bridge/syncService.mjs';

function fixture(){
  const state={mappings:{'chatgpt-web':'account-a'},statuses:{},fallback:{name:'browser-sessions',models:[],saved:false}};
  const writes=[];const connections=[{id:'account-a',provider:'chatgpt-web',authType:'apikey',isActive:true,name:'First'},
    {id:'account-b',provider:'chatgpt-web',authType:'apikey',isActive:true,name:'Second'}];
  const gateway={listConnections:async()=>connections,updateCredential:async(id,cookie)=>writes.push({id,cookie}),
    testConnection:async()=>({valid:true}),listModels:async()=>[{id:'chatgpt-web/model-a',provider:'chatgpt-web',label:'Model A'}],
    saveFallback:async models=>({id:'combo-1',models})};
  return {state,writes,gateway,service:new SyncService({gateway,state,persist:async()=>{}})};
}
const payload=(revision,cookie='session-new')=>({provider:'chatgpt-web',connectionId:'account-a',cookie,revision});
test('only the explicitly mapped active account receives the new credential',async()=>{
  const f=fixture();await f.service.sync(payload(1));assert.deepEqual(f.writes,[{id:'account-a',cookie:'session-new'}]);
  await assert.rejects(f.service.sync({...payload(2),connectionId:'account-b'}),/mapped/i);
});
test('failed writes do not advance acknowledgement and identical retries succeed',async()=>{
  const f=fixture();let attempts=0;f.gateway.updateCredential=async()=>{if(++attempts===1)throw new Error('offline')};
  await assert.rejects(f.service.sync(payload(1)));assert.equal(f.state.statuses['chatgpt-web']?.revision,undefined);
  const result=await f.service.sync(payload(1));assert.equal(result.success,true);assert.equal(attempts,2);
});
test('stale revisions and duplicate cookies cannot overwrite a newer session',async()=>{
  const f=fixture();await f.service.sync(payload(2,'newer'));
  const stale=await f.service.sync(payload(1,'older'));assert.equal(stale.stale,true);
  await f.service.sync(payload(3,'newer'));assert.equal(f.writes.length,1);
});
test('disabled, mismatched and unsupported connections are rejected',async()=>{
  const f=fixture();const rows=await f.gateway.listConnections();rows[0].isActive=false;
  await assert.rejects(f.service.sync(payload(1)),/active/i);
  await assert.rejects(f.service.setMapping('zai-web','account-b'),/provider/i);
});
test('synced and validated are separate states and unsupported validation is honest',async()=>{
  const f=fixture();await f.service.sync(payload(1));assert.equal(f.state.statuses['chatgpt-web'].phase,'synced');
  await f.service.validate('chatgpt-web');assert.equal(f.state.statuses['chatgpt-web'].phase,'validated');
  f.gateway.testConnection=async()=>({valid:false,diagnosis:{unsupported:true},error:'Provider validation not supported'});
  await f.service.validate('chatgpt-web');assert.equal(f.state.statuses['chatgpt-web'].phase,'synced');
});
test('fallback rejects models outside the currently available browser-provider catalog',async()=>{
  const f=fixture();await assert.rejects(f.service.saveFallback(['openai/paid-model']),/available/i);
  await f.service.saveFallback(['chatgpt-web/model-a']);assert.equal(f.state.fallback.saved,true);
});

test('structured upstream auth failures request login without claiming a validation time',async()=>{
  const f=fixture();await f.service.sync(payload(1));
  f.gateway.testConnection=async()=>({valid:false,error:'Access denied',diagnosis:{type:'upstream_auth_error',code:'403'}});
  const result=await f.service.validate('chatgpt-web');
  assert.equal(result.phase,'login-required');
  assert.equal(f.state.statuses['chatgpt-web'].lastValidatedAt,undefined);
});

test('failed or unsupported tests preserve the last successful validation timestamp',async()=>{
  const f=fixture();await f.service.sync(payload(1));await f.service.validate('chatgpt-web');
  assert.ok(f.state.statuses['chatgpt-web'].lastValidatedAt);
  const lastSuccess='2026-01-01T00:00:00.000Z';
  f.state.statuses['chatgpt-web'].lastValidatedAt=lastSuccess;
  for(const diagnosis of [{type:'upstream_rate_limited',code:'429'},{type:'unsupported',code:'unsupported'}]){
    f.gateway.testConnection=async()=>({valid:false,diagnosis});
    const result=await f.service.validate('chatgpt-web');
    assert.equal(result.phase,diagnosis.type==='unsupported'?'synced':'error');
    assert.equal(f.state.statuses['chatgpt-web'].lastValidatedAt,lastSuccess);
  }
});

test('a failed mapping commit cannot contaminate a concurrent successful provider commit',async()=>{
  const state={mappings:{},statuses:{}};let disk=structuredClone(state);let tail=Promise.resolve();let saves=0;
  let entered;const firstStarted=new Promise(resolve=>{entered=resolve});
  let fail;const firstSave=new Promise((_,reject)=>{fail=reject});
  const persist=(candidate=state)=>{
    const snapshot=structuredClone(candidate);
    tail=tail.catch(()=>{}).then(async()=>{if(++saves===1){entered();await firstSave}disk=snapshot});
    return tail;
  };
  const gateway={listConnections:async()=>[
    {id:'chat',provider:'chatgpt-web',isActive:true,authType:'apikey'},
    {id:'gemini',provider:'gemini-web',isActive:true,authType:'apikey'}]};
  const service=new SyncService({state,gateway,persist});
  const failed=assert.rejects(service.setMapping('chatgpt-web','chat'),/storage unavailable/);
  await firstStarted;const succeeding=service.setMapping('gemini-web','gemini');
  await new Promise(resolve=>setImmediate(resolve));fail(new Error('storage unavailable'));
  await failed;assert.equal((await succeeding).success,true);
  assert.deepEqual(state.mappings,{'gemini-web':'gemini'});
  assert.deepEqual(state.statuses,{'gemini-web':{phase:'pending'}});
  assert.deepEqual(disk,state);
});

test('failed sync, validation and fallback commits leave the acknowledged state unchanged',async()=>{
  for(const operation of ['sync','validate','fallback']){
    const f=fixture();await f.service.sync(payload(1));const previous=structuredClone(f.state);
    f.service.persist=async()=>{throw new Error('storage unavailable')};
    const request=operation==='sync'?f.service.sync(payload(2,'rotated-session'))
      :operation==='validate'?f.service.validate('chatgpt-web'):f.service.saveFallback(['chatgpt-web/model-a']);
    await assert.rejects(request,/storage unavailable/);assert.deepEqual(f.state,previous,operation);
  }
});
