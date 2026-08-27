const test = require('node:test');
const assert = require('node:assert/strict');
const { completeVerificationBrainRun } = require('../src/services/autopilot');

class Snap { constructor(id, data, ref) { this.id=id; this._data=data; this.ref=ref; this.exists=Boolean(data); } data(){ return this._data ? {...this._data} : undefined; } }
class Doc { constructor(db,c,id){this.db=db;this.c=c;this.id=id||db.next(c);} async get(){return new Snap(this.id,this.db.get(this.c,this.id),this);} async set(d,o={}){this.db.set(this.c,this.id,d,o);} async update(d){this.db.update(this.c,this.id,d);} }
class Query { constructor(db,c,f=[]){this.db=db;this.c=c;this.f=f;} where(field,op,value){assert.equal(op,'==');return new Query(this.db,this.c,[...this.f,{field,value}]);} limit(){return this;} async get(){return {docs:Object.entries(this.db.data[this.c]||{}).filter(([,d])=>this.f.every(x=>d[x.field]===x.value)).map(([id,d])=>new Snap(id,d,new Doc(this.db,this.c,id)))};} }
class Coll extends Query { doc(id){return new Doc(this.db,this.c,id);} }
class Tx { async get(x){return x.get();} set(ref,d,o){ref.db.set(ref.c,ref.id,d,o);} update(ref,d){ref.db.update(ref.c,ref.id,d);} }
class DB { constructor(){this.data={};this.n={};} collection(c){if(!this.data[c])this.data[c]={};return new Coll(this,c);} next(c){this.n[c]=(this.n[c]||0)+1;return `${c}_${this.n[c]}`;} get(c,id){return this.data[c]?.[id]||null;} set(c,id,d,o={}){if(!this.data[c])this.data[c]={};this.data[c][id]=o.merge?{...(this.data[c][id]||{}),...d}:{...d};} update(c,id,d){this.data[c][id]={...(this.data[c][id]||{}),...d};} async runTransaction(fn){return fn(new Tx());} }

function seed() {
  const db = new DB();
  db.set('roadmaps','r1',{id:'r1',tenant_id:'t1',workspace_id:'w1',project_id:'p1',title:'W01',objective:'Autopilot',state:'ACTIVE',owner_worker_id:'W01',auto_advance:false,milestones:[{id:'m1',title:'Autopilot Loop',state:'VERIFYING',order:1,depends_on:[],mission_id:'mission1'}]});
  db.set('missions','mission1',{id:'mission1',tenant_id:'t1',workspace_id:'w1',project_id:'p1',preferred_worker_id:'W01',priority:'HIGH',state:'RUNNING',autopilot_mode:true,autopilot_attempt_count:1,autopilot_max_attempts:3,roadmap_id:'r1',milestone_id:'m1'});
  db.set('runs','verify1',{id:'verify1',tenant_id:'t1',run_type:'BRAIN_RUN',state:'RUNNING',mission_id:'mission1',roadmap_id:'r1',milestone_id:'m1',autopilot_phase:'VERIFY_EXECUTION'});
  return db;
}

test('RETRY preserves Brain allowed_files in both task_spec and brain_output.task_spec', async () => {
  const db = seed();
  const allowed = ['src/services/autopilot.js', 'test/autopilot-v3-loop.test.js'];
  const out = await completeVerificationBrainRun(db,'t1','verify1',{output_text:`<MRAPI_AUTOPILOT>${JSON.stringify({action:'RETRY',reason:'bounded fix',execution_spec:{instructions:'Apply exact bounded fix',allowed_files:allowed,required_tests:['node --test retry.test.js'],success_criteria:['focused tests pass'],stop_conditions:['NO DEPLOY']}})}</MRAPI_AUTOPILOT>`});
  assert.equal(out.action,'RETRY');
  const task = db.get('tasks',out.task_id);
  assert.deepEqual(task.task_spec.allowed_files, allowed);
  assert.deepEqual(task.brain_output.task_spec.allowed_files, allowed);
});

test('RETRY without allowed_files blocks instead of queuing an unsafe executor task', async () => {
  const db = seed();
  const out = await completeVerificationBrainRun(db,'t1','verify1',{output_text:'<MRAPI_AUTOPILOT>{"action":"RETRY","reason":"fix","execution_spec":{"instructions":"change code","success_criteria":["ok"],"stop_conditions":["NO DEPLOY"]}}</MRAPI_AUTOPILOT>'});
  assert.equal(out.action,'BLOCKED');
  assert.match(out.reason,/allowed_files/i);
  assert.equal(Object.keys(db.data.tasks || {}).length,0);
});


test('RETRY stores prior allowed_files for audit but active task uses only current Brain scope', async () => {
  const db = seed();
  db.set('tasks','task_prev',{
    id:'task_prev',tenant_id:'t1',mission_id:'mission1',
    task_spec:{allowed_files:['src/services/autopilot.js','src/services/orchestration.js']},
    brain_output:{task_spec:{allowed_files:['src/services/autopilot.js','src/services/orchestration.js']}}
  });
  db.set('missions','mission1',{
    ...db.get('missions','mission1'),
    current_task_id:'task_prev'
  });
  const out = await completeVerificationBrainRun(db,'t1','verify1',{output_text:`<MRAPI_AUTOPILOT>${JSON.stringify({action:'RETRY',reason:'bounded fix',execution_spec:{instructions:'Apply follow-up fix',allowed_files:['test/autopilot-v3-loop.test.js'],required_tests:['node --test retry.test.js'],success_criteria:['focused tests pass'],stop_conditions:['NO DEPLOY']}})}</MRAPI_AUTOPILOT>`});
  assert.equal(out.action,'RETRY');
  const task = db.get('tasks',out.task_id);
  const expected = ['test/autopilot-v3-loop.test.js'];
  assert.deepEqual(task.task_spec.allowed_files, expected);
  assert.deepEqual(task.brain_output.task_spec.allowed_files, expected);
  assert.deepEqual(db.get('missions','mission1').autopilot_allowed_files, expected);
  assert.equal(db.get('missions','mission1').autopilot_retry_history[0].prior_task_id, 'task_prev');
});
