const test = require('node:test');
const assert = require('node:assert/strict');
const { notificationKind, notifyMission } = require('../src/services/telegramNotifications');

class Doc {
  constructor(id, store) { this.id=id; this.store=store; }
  async get() { const v=this.store.get(this.id); return { exists:v!==undefined, data:()=>v }; }
  async set(v,o={}) { const p=this.store.get(this.id)||{}; this.store.set(this.id,o.merge?{...p,...v}:v); }
}
class Collection { constructor(store){this.store=store;} doc(id){return new Doc(id,this.store);} }
class FakeDb {
  constructor(){this.s=new Map();}
  collection(n){ if(!this.s.has(n)) this.s.set(n,new Map()); return new Collection(this.s.get(n)); }
}
const env = {
  TELEGRAM_GATEWAY_URL:'https://gateway.example',
  TELEGRAM_BUSINESS_ID:'scb',
  TELEGRAM_CHAT_ID:'123',
  TELEGRAM_GATEWAY_API_KEY:'key'
};

test('target states',()=>{
  assert.equal(notificationKind({state:'BLOCKED'}),'MISSION_BLOCKED');
  assert.equal(notificationKind({state:'FAILED'}),'MISSION_FAILED');
  assert.equal(notificationKind({state:'NEED_HUMAN_ACTION'}),'HUMAN_ACTION_REQUIRED');
  assert.equal(notificationKind({state:'COMPLETED'}),'MISSION_COMPLETED');
  assert.equal(notificationKind({state:'RUNNING'}),null);
});

test('send + dedupe', async()=>{
  const db=new FakeDb(); let n=0;
  const mission={id:'m1',tenant_id:'t',state:'BLOCKED',objective:'test'};
  const fetchImpl=async()=>({ok:true,status:200,text:async()=>JSON.stringify({ok:true})});
  const a=await notifyMission({db,mission,env,fetchImpl});
  n += a.sent ? 1 : 0;
  const b=await notifyMission({db,mission,env,fetchImpl});
  n += b.sent ? 1 : 0;
  assert.equal(n,1);
  assert.equal(b.reason,'ALREADY_SENT');
});

test('gateway failure does not throw', async()=>{
  const db=new FakeDb();
  const r=await notifyMission({
    db,
    mission:{id:'m2',tenant_id:'t',state:'FAILED',objective:'x'},
    env,
    fetchImpl:async()=>({ok:false,status:500,text:async()=> 'down'})
  });
  assert.equal(r.failed,true);
});
