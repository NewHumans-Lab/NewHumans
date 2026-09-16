import http from 'node:http';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPool, withTransaction } from '../../src/db.js';
import { createEntity, runCommand } from '../../src/services/core.js';
import { firstActivation, mint, quoteResource, reserve } from '../../src/services/economy.js';
import { cancelExecution, getUsageReceipt, infer, registerConnector, registerDescriptor } from '../../src/services/gateway.js';

const pool=createPool();
const world='p1-4-test';
const today=new Date().toISOString().slice(0,10);
let system;

async function reset(){
  await pool.query(`TRUNCATE gateway.reconciliation_jobs,gateway.usage_receipts,gateway.provider_requests,gateway.execution_attempts,gateway.executions,economy.resource_quotes,gateway.connector_configs,gateway.credential_refs,gateway.capability_descriptors,core.consumer_receipts,core.outbox,core.life_events,economy.activity_fees,economy.activity_subjects,economy.reservations,economy.postings,economy.journals,economy.wallets,core.actions,core.capability_grants,core.entities RESTART IDENTITY CASCADE`);
  system=await withTransaction(pool,(c)=>createEntity(c,{worldId:world,entityType:'SYSTEM',displayId:'system',name:'System'}));
}
async function agent(name){
  const a=await withTransaction(pool,(c)=>createEntity(c,{worldId:world,entityType:'AGENT',displayId:`${name}-${crypto.randomUUID()}`,name,createdBy:system.entity_id},{actorEntityId:system.entity_id}));
  await runCommand(pool,{worldId:world,actorEntityId:system.entity_id,actionType:'economy.mint',idempotencyKey:`mint-${a.entity_id}`,payload:{amount:'110000000'}},(c,ctx)=>mint(c,{worldId:world,targetEntityId:a.entity_id,amountMicroE:'110000000',basisKey:`seed-${a.entity_id}`,actorEntityId:system.entity_id,actionId:ctx.actionId}));
  await runCommand(pool,{worldId:world,actorEntityId:a.entity_id,actionType:'economy.first_activation',idempotencyKey:`activate-${a.entity_id}`,payload:{today}},(c,ctx)=>firstActivation(c,{worldId:world,entityId:a.entity_id,billingDate:today,actorEntityId:a.entity_id,actionId:ctx.actionId}));
  return a;
}
async function provider(handler){
  let calls=0;
  const server=http.createServer(async(req,res)=>{calls++;for await(const _ of req){} await handler({res,calls});});
  await new Promise((resolve)=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();
  return{baseUrl:`http://127.0.0.1:${address.port}/`,get calls(){return calls},close:()=>new Promise((resolve)=>server.close(resolve))};
}
function success(res,{input=10,output=5,text='ok'}={}){res.writeHead(200,{'content-type':'application/json','x-request-id':'p14'});res.end(JSON.stringify({id:'p14',choices:[{message:{content:text}}],usage:{prompt_tokens:input,completion_tokens:output,total_tokens:input+output}}));}
async function configure(baseUrl,{maxRetries=0,supportsIdempotency=false}={}){
  return withTransaction(pool,async(c)=>{
    const descriptor=await registerDescriptor(c,{worldId:world,actorEntityId:system.entity_id,descriptorKey:`model-${crypto.randomUUID()}`,modelReference:'p14-model',maxInputTokens:4096,maxOutputTokens:256,timeoutMs:1000,maxRetries,supportsIdempotency,inputRateMicroEPerMillion:'1000000',outputRateMicroEPerMillion:'2000000'});
    const connector=await registerConnector(c,{worldId:world,actorEntityId:system.entity_id,descriptorId:descriptor.descriptor_id,connectorKind:'LOCAL_SELF_HOSTED',billingMode:'PLATFORM_PREPAID',baseUrl});
    return{descriptor,connector};
  });
}
async function quotedReservation(a,descriptor){
  const quoted=await runCommand(pool,{worldId:world,actorEntityId:a.entity_id,actionType:'economy.quote',idempotencyKey:`quote-${crypto.randomUUID()}`,payload:{descriptorId:descriptor.descriptor_id}},(c,ctx)=>quoteResource(c,{worldId:world,payerEntityId:a.entity_id,activitySubjectId:a.entity_id,descriptorId:descriptor.descriptor_id,maxInputTokens:4096,maxOutputTokens:256,actorEntityId:a.entity_id,actionId:ctx.actionId}));
  const quote=quoted.result;
  const reserved=await runCommand(pool,{worldId:world,actorEntityId:a.entity_id,actionType:'economy.reserve',idempotencyKey:`reserve-${crypto.randomUUID()}`,payload:{quoteId:quote.quote_id}},(c,ctx)=>reserve(c,{worldId:world,entityId:a.entity_id,amountMicroE:quote.max_cost_micro_e,businessKey:`quote-${quote.quote_id}`,quoteId:quote.quote_id,actorEntityId:a.entity_id,actionId:ctx.actionId}));
  return{quote,reservationId:reserved.result.reservationId};
}
function input(a,descriptor,connector,reservationId,quoteId,overrides={}){
  return{worldId:world,actorEntityId:a.entity_id,idempotencyKey:`infer-${crypto.randomUUID()}`,descriptorId:descriptor.descriptor_id,connectorId:connector.connector_id,activitySubjectId:a.entity_id,payerEntityId:a.entity_id,reservationId,quoteId,billingDate:today,messages:[{role:'user',content:'hello'}],maxOutputTokens:32,requireExplicitQuote:true,...overrides};
}

test.beforeEach(reset);
test.after(async()=>pool.end());

test('platform-paid chain is quote -> reservation -> execution -> receipt -> settlement',async()=>{
  const p=await provider(async({res})=>success(res));
  try{
    const {descriptor,connector}=await configure(p.baseUrl); const a=await agent('chain'); const {quote,reservationId}=await quotedReservation(a,descriptor);
    const out=await infer(pool,input(a,descriptor,connector,reservationId,quote.quote_id));
    assert.equal(out.status,'SUCCEEDED'); assert.equal(out.quoteId,quote.quote_id); assert.equal(out.chargeMicroE,'20');
    const q=(await pool.query('SELECT status FROM economy.resource_quotes WHERE quote_id=$1',[quote.quote_id])).rows[0]; assert.equal(q.status,'CONSUMED');
    const r=(await pool.query('SELECT status,settled_amount_micro_e,quote_id FROM economy.reservations WHERE reservation_id=$1',[reservationId])).rows[0]; assert.equal(r.status,'SETTLED'); assert.equal(r.settled_amount_micro_e,'20'); assert.equal(r.quote_id,quote.quote_id);
    const e=(await pool.query('SELECT quote_id FROM gateway.executions WHERE execution_id=$1',[out.executionId])).rows[0]; assert.equal(e.quote_id,quote.quote_id);
    const receipt=await getUsageReceipt(pool,{worldId:world,receiptId:out.receiptId,actorEntityId:a.entity_id}); assert.equal(receipt.execution_id,out.executionId); assert.equal(receipt.quote_id,quote.quote_id);
  }finally{await p.close();}
});

test('strict P1.4 platform inference rejects an unquoted reservation',async()=>{
  const p=await provider(async({res})=>success(res));
  try{
    const {descriptor,connector}=await configure(p.baseUrl); const a=await agent('strict');
    const reserved=await runCommand(pool,{worldId:world,actorEntityId:a.entity_id,actionType:'economy.reserve',idempotencyKey:'legacy-reserve',payload:{}},(c,ctx)=>reserve(c,{worldId:world,entityId:a.entity_id,amountMicroE:'1000000',businessKey:'legacy-reserve',actorEntityId:a.entity_id,actionId:ctx.actionId}));
    await assert.rejects(()=>infer(pool,input(a,descriptor,connector,reserved.result.reservationId,null)),e=>e.code==='QUOTE_REQUIRED');
    assert.equal(p.calls,0);
  }finally{await p.close();}
});

test('maxRetries=3 means one initial attempt plus at most three retries',async()=>{
  const p=await provider(async({res,calls})=>{
    if(calls<4){res.writeHead(503,{'content-type':'application/json','retry-after':'0'});res.end(JSON.stringify({error:'temporary'}));}
    else success(res);
  });
  try{
    const {descriptor,connector}=await configure(p.baseUrl,{maxRetries:3,supportsIdempotency:true}); const a=await agent('retries'); const {quote,reservationId}=await quotedReservation(a,descriptor);
    const out=await infer(pool,input(a,descriptor,connector,reservationId,quote.quote_id));
    assert.equal(out.status,'SUCCEEDED'); assert.equal(p.calls,4);
    const attempts=(await pool.query('SELECT count(*)::int n,max(attempt_no)::int max_no FROM gateway.execution_attempts WHERE execution_id=$1',[out.executionId])).rows[0];
    assert.equal(attempts.n,4); assert.equal(attempts.max_no,4);
  }finally{await p.close();}
});

test('gateway.cancel cancels an undispatched execution and releases its quote-backed reservation',async()=>{
  const p=await provider(async({res})=>success(res));
  try{
    const {descriptor,connector}=await configure(p.baseUrl); const a=await agent('cancel'); const {quote,reservationId}=await quotedReservation(a,descriptor);
    const prepared=await withTransaction(pool,async(c)=>{
      const action=(await c.query(`INSERT INTO core.actions (world_id,actor_entity_id,action_type,idempotency_key,payload_hash,status) VALUES ($1,$2,'gateway.infer',$3,$4,'PENDING') RETURNING action_id`,[world,a.entity_id,`manual-${crypto.randomUUID()}`,'a'.repeat(64)])).rows[0];
      const execution=(await c.query(`INSERT INTO gateway.executions (world_id,action_id,activity_subject_id,payer_entity_id,descriptor_id,connector_id,reservation_id,quote_id,billing_date,action_purpose,input_digest,max_charge_micro_e,status) VALUES ($1,$2,$3,$3,$4,$5,$6,$7,$8,'PRIMARY_INFERENCE',$9,$10,'PROPOSED') RETURNING execution_id`,[world,action.action_id,a.entity_id,descriptor.descriptor_id,connector.connector_id,reservationId,quote.quote_id,today,'b'.repeat(64),quote.max_cost_micro_e])).rows[0];
      return{actionId:action.action_id,executionId:execution.execution_id};
    });
    const out=await withTransaction(pool,(c)=>cancelExecution(c,{worldId:world,executionId:prepared.executionId,actorEntityId:a.entity_id,actionId:prepared.actionId}));
    assert.equal(out.status,'CANCELLED'); assert.equal(out.cancellationAccepted,true);
    assert.equal((await pool.query('SELECT status FROM economy.reservations WHERE reservation_id=$1',[reservationId])).rows[0].status,'RELEASED');
    assert.equal((await pool.query('SELECT status FROM economy.resource_quotes WHERE quote_id=$1',[quote.quote_id])).rows[0].status,'CANCELLED');
    assert.equal((await pool.query('SELECT status FROM core.actions WHERE action_id=$1',[prepared.actionId])).rows[0].status,'CANCELLED');
  }finally{await p.close();}
});
