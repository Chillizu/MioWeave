import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const session = {};
let onMessage;
globalThis.chrome = {
  runtime:{id:'test-extension',getURL:path=>'chrome-extension://test-extension/'+path,
    onMessage:{addListener:fn=>{onMessage=fn}}},
  storage:{
    local:{async get(){return {}},async set(){}},
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
const chatId='long-task-test';
const record={tool:'edit',argsHash:'hash1',phase:'result-ready',
  payload:{ok:true,result:{structuredContent:{applied:1}}}};
assert.equal((await request({type:'WEBMCP_RECOVERY_SAVE',chatId,callId:'edit_1',record})).ok,true);
assert.equal((await request({type:'WEBMCP_RECOVERY_LOAD',chatId})).records.edit_1.tool,'edit');
assert.equal((await request({type:'WEBMCP_RECOVERY_LOAD',chatId},forged)).ok,false);
assert.equal((await request({type:'WEBMCP_RECOVERY_SAVE',chatId,callId:'edit_2',record},forged)).ok,false);
assert.equal((await request({type:'WEBMCP_RECOVERY_LOAD',chatId:'../../another-chat'})).ok,true);
assert.deepEqual((await request({type:'WEBMCP_RECOVERY_LOAD',chatId:'../../another-chat'})).records,{});
assert.equal((await request({type:'WEBMCP_RECOVERY_SAVE',chatId,callId:'big',
  record:{...record,payload:{ok:true,result:{output:'X'.repeat(30000)}}}})).ok,false);
const entries=Object.keys((await request({type:'WEBMCP_RECOVERY_LOAD',chatId})).records);
assert.deepEqual(entries,['edit_1']);
const key='mioweave-recovery-v1:'+chatId;
session[key].edit_1.at=Date.now()-5*60*60*1000;
assert.deepEqual((await request({type:'WEBMCP_RECOVERY_LOAD',chatId})).records,{});
console.log('[PASS] recovery journal: sender validation, chat isolation, 27K size limit, 4h TTL');
