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
