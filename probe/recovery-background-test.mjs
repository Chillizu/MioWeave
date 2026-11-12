import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const session = {};
const local = {};
let onMessage;
globalThis.chrome = {
  runtime:{id:'test-extension',getURL:path=>'chrome-extension://test-extension/'+path,
    onMessage:{addListener:fn=>{onMessage=fn}}},
  storage:{
    local:{async get(){return {...local}},async set(patch){Object.assign(local,patch)}},
    session:{async get(key){return {[key]:session[key]}},async set(patch){Object.assign(session,patch)}}
  }
};
await import(pathToFileURL(resolve('extension/background.js')).href);
assert.equal(typeof onMessage,'function');
const trusted={id:'test-extension',url:'https://chat.deepseek.com/a/chat/s/test'};
const forged={id:'test-extension',url:'https://other.example/chat'};
const request=(payload,sender=trusted)=>new Promise((resolveResponse,reject)=>{
  let done=false;
  const timer=setTimeout(()=>reject(Error('background reply timed out')),2500);
  onMessage(payload,sender,response=>{done=true;clearTimeout(timer);resolveResponse(response)});
});

const optionsURL = chrome.runtime.getURL('options.html');
const optionsSender = {id:chrome.runtime.id,url:optionsURL};
const setPolicy = mode => ({type:'WEBMCP_GLOBAL_POLICY_SET',mode});
assert.equal((await request(setPolicy('block'), {...optionsSender,url:optionsURL+'#permissions'})).ok,true);
assert.equal((await request({type:'WEBMCP_CONFIG_GET'},optionsSender)).config.approvalMode,'block');
for (const sender of [
  trusted,
  {id:'another-extension',url:optionsURL+'#permissions'},
  {...optionsSender,url:optionsURL+'.extra#permissions'},
  {...optionsSender,url:optionsURL+'?view=permissions#permissions'},
  {id:chrome.runtime.id}
]) {
  assert.equal((await request(setPolicy('always'),sender)).ok,false);
}
assert.equal((await request({type:'WEBMCP_CONFIG_GET'},optionsSender)).config.approvalMode,'block');
assert.equal((await request(setPolicy('ask'),optionsSender)).ok,true);
assert.equal((await request({type:'WEBMCP_CONFIG_GET'},optionsSender)).config.approvalMode,'ask');
console.log('[PASS] options policy: same-document fragments accepted; foreign sender, other path and query denied');
const chatId='long-task-test';
const record={tool:'edit',argsHash:'hash1',phase:'result-ready',
  payload:{ok:true,result:{structuredContent:{applied:1}}}};
assert.equal((await request({type:'WEBMCP_RECOVERY_SAVE',chatId,callId:'edit_1',record})).ok,true);
assert.equal((await request({type:'WEBMCP_RECOVERY_LOAD',chatId})).records.edit_1.tool,'edit');
assert.equal((await request({type:'WEBMCP_RECOVERY_SAVE',chatId,callId:'callback_1',
  record:{...record,phase:'continuing'}})).ok,true);
assert.equal((await request({type:'WEBMCP_RECOVERY_LOAD',chatId})).records.callback_1.phase,'continuing');
assert.equal((await request({type:'WEBMCP_RECOVERY_LOAD',chatId},forged)).ok,false);
assert.equal((await request({type:'WEBMCP_RECOVERY_SAVE',chatId,callId:'edit_2',record},forged)).ok,false);
assert.equal((await request({type:'WEBMCP_RECOVERY_LOAD',chatId:'../../another-chat'})).ok,true);
assert.deepEqual((await request({type:'WEBMCP_RECOVERY_LOAD',chatId:'../../another-chat'})).records,{});
assert.equal((await request({type:'WEBMCP_RECOVERY_SAVE',chatId,callId:'big',
  record:{...record,payload:{ok:true,result:{output:'X'.repeat(30000)}}}})).ok,false);
const entries=Object.keys((await request({type:'WEBMCP_RECOVERY_LOAD',chatId})).records);
assert.deepEqual(entries.sort(),['callback_1','edit_1'].sort());
const key='mioweave-recovery-v1:'+chatId;
session[key].edit_1.at=Date.now()-5*60*60*1000;
session[key].callback_1.at=Date.now()-5*60*60*1000;
assert.deepEqual((await request({type:'WEBMCP_RECOVERY_LOAD',chatId})).records,{});
console.log('[PASS] recovery journal: sender validation, chat isolation, 27K size limit, 4h TTL');
