const test = require('node:test');
const assert = require('node:assert/strict');

const {
  notificationKind,
  reserveDeliveryAtomic
} = require('../src/services/telegramNotifications');

class Snap {
  constructor(v){ this.v=v; this.exists=v!==undefined; }
  data(){ return this.v; }
}
class Ref {
  constructor(store,id){ this.store=store; this.id=id; }
  async get(){ return new Snap(this.store.get(this.id)); }
  async set(v,o={}){ const p=this.store.get(this.id)||{}; this.store.set(this.id,o.merge?{...p,...v}:v); }
}
class Collection {
  constructor(store){ this.store=store; }
  doc(id){ return new Ref(this.store,id); }
}
class Tx {
  async get(ref){ return ref.get(); }
  set(ref,v,o){ return ref.set(v,o); }
}
class FakeDb {
  constructor(){ this.s=new Map(); this.chain=Promise.resolve(); }
  collection(n){ if(!this.s.has(n)) this.s.set(n,new Map()); return new Collection(this.s.get(n)); }
  async runTransaction(fn){
    const prev=this.chain;
    let release;
    this.chain=new Promise(r=>release=r);
    await prev;
    try { return await fn(new Tx()); }
    finally { release(); }
  }
}

test('target states',()=>{
  assert.equal(notificationKind({state:'BLOCKED'}),'MISSION_BLOCKED');
  assert.equal(notificationKind({state:'RUNNING'}),null);
});

test('atomic reservation prevents duplicate send across concurrent instances', async()=>{
  const db=new FakeDb();
  const mission={id:'m1',tenant_id:'t',state:'COMPLETED'};

  const [a,b]=await Promise.all([
    reserveDeliveryAtomic(db,'fp',mission,'MISSION_COMPLETED'),
    reserveDeliveryAtomic(db,'fp',mission,'MISSION_COMPLETED')
  ]);

  assert.equal([a.reserved,b.reserved].filter(Boolean).length,1);
  assert.equal([a.reason,b.reason].filter(Boolean)[0],'ALREADY_PENDING');
});
