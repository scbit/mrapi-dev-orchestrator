const test = require('node:test');
const assert = require('node:assert/strict');
const {
  startNextRoadmapMilestone,
  completeVerificationBrainRun
} = require('../src/services/autopilot');
const { completeRun } = require('../src/services/orchestration');

class Snap { constructor(id, data, ref) { this.id=id; this._data=data; this.ref=ref; this.exists=Boolean(data); } data(){ return this._data ? {...this._data} : undefined; } }
class Doc { constructor(db,c,id){this.db=db;this.c=c;this.id=id||db.next(c);} async get(){return new Snap(this.id,this.db.get(this.c,this.id),this);} async set(d,o={}){this.db.set(this.c,this.id,d,o);} async update(d){this.db.update(this.c,this.id,d);} }
class Query { constructor(db,c,f=[]){this.db=db;this.c=c;this.f=f;} where(field,op,value){assert.equal(op,'==');return new Query(this.db,this.c,[...this.f,{field,value}]);} limit(){return this;} async get(){return {docs:Object.entries(this.db.data[this.c]||{}).filter(([,d])=>this.f.every(x=>d[x.field]===x.value)).map(([id,d])=>new Snap(id,d,new Doc(this.db,this.c,id)))};} }
class Coll extends Query { doc(id){return new Doc(this.db,this.c,id);} }
class Tx { async get(x){return x.get();} set(ref,d,o){ref.db.set(ref.c,ref.id,d,o);} update(ref,d){ref.db.update(ref.c,ref.id,d);} }
class DB { constructor(){this.data={};this.n={};} collection(c){if(!this.data[c])this.data[c]={};return new Coll(this,c);} next(c){this.n[c]=(this.n[c]||0)+1;return `${c}_${this.n[c]}`;} get(c,id){return this.data[c]?.[id]||null;} set(c,id,d,o={}){if(!this.data[c])this.data[c]={};this.data[c][id]=o.merge?{...(this.data[c][id]||{}),...d}:{...d};} update(c,id,d){if(!this.data[c]?.[id])throw new Error('NOT_FOUND');this.data[c][id]={...this.data[c][id],...d};} async runTransaction(fn){return fn(new Tx());} }

function seed(db){
  db.set('projects','p1',{id:'p1',tenant_id:'t1',workspace_id:'w1',repository_full_name:'scbit/mrapi-dev-orchestrator',local_path:'C:/repo',default_branch:'main',default_worker_id:'W01',reusable_instructions:'Brain programs; Codex executes.'});
  db.set('workers','W01',{id:'W01',tenant_id:'t1',state:'IDLE'});
  db.set('roadmaps','r1',{id:'r1',tenant_id:'t1',workspace_id:'w1',project_id:'p1',title:'Finish W01 Autopilot',objective:'Finish loop',state:'ACTIVE',owner_worker_id:'W01',auto_advance:false,milestones:[{id:'m0',title:'Context',state:'COMPLETED',order:1,depends_on:[]},{id:'m1',title:'Autopilot Loop',state:'PENDING',order:2,depends_on:[]} ]});
}

test('startNextRoadmapMilestone creates an approved autopilot mission and moves milestone to PLANNING', async()=>{
  const db=new DB(); seed(db);
  const started=await startNextRoadmapMilestone(db,'t1','r1');
  assert.equal(started.milestone.id,'m1');
  const mission=db.get('missions',started.mission.id);
  assert.equal(mission.planning_mode,'AUTOPILOT');
  assert.equal(mission.approval_status,'APPROVED');
  assert.match(mission.objective,/Codex is hands only/i);
  assert.equal(db.get('roadmaps','r1').milestones[1].state,'PLANNING');
});

test('verification COMPLETE closes mission and milestone', async()=>{
  const db=new DB(); seed(db);
  db.set('missions','mission1',{id:'mission1',tenant_id:'t1',workspace_id:'w1',project_id:'p1',preferred_worker_id:'W01',state:'RUNNING',autopilot_mode:true,autopilot_attempt_count:1,autopilot_max_attempts:3,roadmap_id:'r1',milestone_id:'m1'});
  db.set('runs','verify1',{id:'verify1',tenant_id:'t1',run_type:'BRAIN_RUN',state:'RUNNING',mission_id:'mission1',roadmap_id:'r1',milestone_id:'m1',autopilot_phase:'VERIFY_EXECUTION'});
  const out=await completeVerificationBrainRun(db,'t1','verify1',{output_text:'<MRAPI_AUTOPILOT>{"action":"COMPLETE","reason":"tests pass"}</MRAPI_AUTOPILOT>'});
  assert.equal(out.action,'COMPLETE');
  assert.equal(db.get('missions','mission1').state,'COMPLETED');
  assert.equal(db.get('roadmaps','r1').milestones[1].state,'COMPLETED');
});

test('verification RETRY creates bounded Brain-authored executor task', async()=>{
  const db=new DB(); seed(db);
  db.set('missions','mission1',{id:'mission1',tenant_id:'t1',workspace_id:'w1',project_id:'p1',preferred_worker_id:'W01',priority:'HIGH',state:'RUNNING',autopilot_mode:true,autopilot_attempt_count:1,autopilot_max_attempts:3,roadmap_id:'r1',milestone_id:'m1'});
  db.set('runs','verify1',{id:'verify1',tenant_id:'t1',run_type:'BRAIN_RUN',state:'RUNNING',mission_id:'mission1',roadmap_id:'r1',milestone_id:'m1',autopilot_phase:'VERIFY_EXECUTION'});
  const out=await completeVerificationBrainRun(db,'t1','verify1',{output_text:'<MRAPI_AUTOPILOT>{"action":"RETRY","reason":"fix test","execution_spec":{"instructions":"Change x.js exactly, then run tests.","allowed_files":["x.js"],"required_tests":["node --test x.test.js"],"success_criteria":["all pass"],"stop_conditions":["DO NOT DEPLOY"]}}</MRAPI_AUTOPILOT>'});
  assert.equal(out.action,'RETRY');
  const task=db.get('tasks',out.task_id);
  assert.match(task.task_spec.instructions,/Change x\.js exactly/);
  assert.ok(task.brain_completed_at);
  assert.equal(task.state,'QUEUED');
  assert.equal(db.get('missions','mission1').autopilot_attempt_count,2);
});


test('executor completion is sent back to W01 Brain for verification instead of ending autopilot blindly', async()=>{
  const db=new DB(); seed(db);
  db.set('roadmaps','r1',{...db.get('roadmaps','r1'),milestones:[{id:'m0',title:'Context',state:'COMPLETED',order:1,depends_on:[]},{id:'m1',title:'Autopilot Loop',state:'RUNNING',order:2,depends_on:[],mission_id:'mission1'}]});
  db.set('missions','mission1',{id:'mission1',tenant_id:'t1',workspace_id:'w1',project_id:'p1',preferred_worker_id:'W01',state:'RUNNING',autopilot_mode:true,autopilot_phase:'EXECUTING',autopilot_attempt_count:1,autopilot_max_attempts:3,roadmap_id:'r1',milestone_id:'m1'});
  db.set('workers','W01',{id:'W01',tenant_id:'t1',state:'BUSY',current_mission_id:'mission1',current_task_id:'task1'});
  db.set('executors','exec1',{id:'exec1',tenant_id:'t1',state:'ONLINE',current_run_id:'run1'});
  db.set('tasks','task1',{id:'task1',tenant_id:'t1',mission_id:'mission1',worker_id:'W01',state:'RUNNING',phase:'EXECUTION_RUNNING'});
  db.set('runs','run1',{id:'run1',tenant_id:'t1',run_type:'EXECUTION_RUN',mission_id:'mission1',task_id:'task1',workspace_id:'w1',project_id:'p1',worker_id:'W01',executor_id:'exec1',state:'RUNNING',brain_run_id:'brain1'});
  const done=await completeRun(db,'t1','run1',{success:true,summary:'tests passed',output:{tests:['ok']}});
  assert.ok(done.autopilot_verification);
  const verify=db.get('runs',done.autopilot_verification.verification_run_id);
  assert.equal(verify.run_type,'BRAIN_RUN');
  assert.equal(verify.autopilot_phase,'VERIFY_EXECUTION');
  assert.equal(verify.executor_report.success,true);
  assert.equal(db.get('missions','mission1').autopilot_phase,'VERIFYING');
  assert.equal(db.get('roadmaps','r1').milestones[1].state,'VERIFYING');
});
