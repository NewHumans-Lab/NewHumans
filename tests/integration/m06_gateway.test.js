import http from 'node:http';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPool, withTransaction } from '../../src/db.js';
import { createEntity, runCommand } from '../../src/services/core.js';
import { firstActivation, getWallet, mint, reserve } from '../../src/services/economy.js';
import { infer, registerConnector, registerDescriptor } from '../../src/services/gateway.js';

const pool=createPool(); const world='gateway-test'; const today=new Date().toISOString().slice(0,10); let system;
async function reset(){
  await pool.query(`TRUNCATE gateway.reconciliation_jobs,gateway.usage_receipts,gateway.provider_requests,gateway.execution_attempts,gateway.executions,gateway.connector_configs,gateway.credential_refs,gateway.capability_descriptors,core.consumer_receipts,core.outbox,core.life_events,economy.activity_fees,economy.activity_subjects,economy.reservations,economy.postings,economy.journals,economy.wallets,core.actions,core.capability_grants,core.entities RESTART IDENTITY CASCADE`);
  system=await withTransaction(pool,(c)=>createEntity(c,{worldId:world,entityType:'SYSTEM',displayId:'system',name:'System'}));
}
async function entity(type,name,worldId=world,creator=system){return withTransaction(pool,(c)=>createEntity(c,{worldId,entityType:type,displayId:`${name}-${crypto.randomUUID()}`,name,createdBy:creator?.entity_id ?? null},{actorEntityId:creator?.entity_id ?? null}));}
async function mintTo(target,amount,basis=crypto.randomUUID(),worldId=world,systemActor=system){return runCommand(pool,{worldId,actorEntityId:systemActor.entity_id,actionType:'economy.mint',idempotencyKey:`mint-${basis}`,payload:{target:target.entity_id,amount,basis}},(c,ctx)=>mint(c,{worldId,targetEntityId:target.entity_id,amountMicroE:amount,basisKey:basis,actorEntityId:systemActor.entity_id,actionId:ctx.actionId}));}
async function activate(agent,date=today){return runCommand(pool,{worldId:agent.world_id,actorEntityId:agent.entity_id,actionType:'economy.first_activation',idempotencyKey:`activate-${agent.entity_id}`,payload:{date}},(c,ctx)=>firstActivation(c,{worldId:agent.world_id,entityId:agent.entity_id,billingDate:date,actorEntityId:agent.entity_id,actionId:ctx.actionId}));}
async function reserveFor(agent,amount='1000000',key=crypto.randomUUID()){const out=await runCommand(pool,{worldId:agent.world_id,actorEntityId:agent.entity_id,actionType:'economy.reserve',idempotencyKey:`reserve-${key}`,payload:{amount,key}},(c,ctx)=>reserve(c,{worldId:agent.world_id,entityId:agent.entity_id,amountMicroE:amount,businessKey:key,actorEntityId:agent.entity_id,actionId:ctx.actionId}));return out.result.reservationId;}
async function configure({baseUrl,billingMode='PLATFORM_PREPAID',supportsIdempotency=false,maxAttempts=1,timeoutMs=1000,credentialEnvKey=null,inputRate='1000000',outputRate='2000000'}={}){
  return withTransaction(pool,async(c)=>{
    const descriptor=await registerDescriptor(c,{worldId:world,actorEntityId:system.entity_id,descriptorKey:`model-${crypto.randomUUID()}`,modelReference:'test-model',maxInputTokens:4096,maxOutputTokens:256,timeoutMs,maxAttempts,supportsIdempotency,inputRateMicroEPerMillion:inputRate,outputRateMicroEPerMillion:outputRate});
    const connector=await registerConnector(c,{worldId:world,actorEntityId:system.entity_id,descriptorId:descriptor.descriptor_id,connectorKind:'LOCAL_SELF_HOSTED',billingMode,baseUrl,credentialEnvKey});
    return{descriptor,connector};
  });
}
async function provider(handler){
  let calls=0; const seen=[];
  const server=http.createServer(async(req,res)=>{calls++;const chunks=[];for await(const chunk of req)chunks.push(chunk);const payload=chunks.length?JSON.parse(Buffer.concat(chunks).toString('utf8')):{};seen.push({headers:req.headers,payload});await handler({req,res,payload,calls});});
  await new Promise((resolve)=>server.listen(0,'127.0.0.1',resolve)); const address=server.address();
  return{baseUrl:`http://127.0.0.1:${address.port}/`,get calls(){return calls},seen,close:()=>new Promise((resolve)=>server.close(resolve))};
}
function success(res,{id='req-1',input=10,output=5,text='ok'}={}){res.writeHead(200,{'content-type':'application/json','x-request-id':id});res.end(JSON.stringify({id,choices:[{message:{content:text}}],usage:{prompt_tokens:input,completion_tokens:output,total_tokens:input+output}}));}

test.beforeEach(reset); test.after(async()=>pool.end());

test('platform-paid inference settles measured usage and idempotent replay never redispatches',async()=>{
  const p=await provider(async({res})=>success(res));
  try{
    const {descriptor,connector}=await configure({baseUrl:p.baseUrl}); const agent=await entity('AGENT','paid'); await mintTo(agent,'110000000','paid-seed'); await activate(agent); const reservationId=await reserveFor(agent);
    const input={worldId:world,actorEntityId:agent.entity_id,idempotencyKey:'infer-once',descriptorId:descriptor.descriptor_id,connectorId:connector.connector_id,activitySubjectId:agent.entity_id,payerEntityId:agent.entity_id,reservationId,billingDate:today,messages:[{role:'user',content:'hello'}],maxOutputTokens:32,maxChargeMicroE:'1000000'};
    const first=await infer(pool,input); assert.equal(first.status,'SUCCEEDED'); assert.equal(first.chargeMicroE,'20'); assert.equal(first.output,'ok'); assert.equal(p.calls,1);
    const replay=await infer(pool,input); assert.equal(replay.replayed,true); assert.equal(replay.status,'SUCCEEDED'); assert.equal(p.calls,1);
    const reservation=(await pool.query(`SELECT status,settled_amount_micro_e,settlement_journal_id FROM economy.reservations WHERE reservation_id=$1`,[reservationId])).rows[0]; assert.equal(reservation.status,'SETTLED'); assert.equal(reservation.settled_amount_micro_e,'20'); assert.ok(reservation.settlement_journal_id);
    const wallet=await withTransaction(pool,(c)=>getWallet(c,world,agent.entity_id)); assert.equal(wallet.posted_balance_micro_e,'108999980'); assert.equal(wallet.reserved_micro_e,'0'); assert.equal(wallet.available_micro_e,'108999980');
    assert.equal((await pool.query(`SELECT count(*)::int n FROM gateway.usage_receipts WHERE execution_id=$1`,[first.executionId])).rows[0].n,1);
  }finally{await p.close();}
});

test('missing daily activity fee rejects before provider dispatch',async()=>{
  const p=await provider(async({res})=>success(res));
  try{
    const {descriptor,connector}=await configure({baseUrl:p.baseUrl}); const agent=await entity('AGENT','no-fee'); await mintTo(agent,'110000000','no-fee-seed'); const reservationId=await reserveFor(agent);
    await assert.rejects(()=>infer(pool,{worldId:world,actorEntityId:agent.entity_id,idempotencyKey:'no-fee',descriptorId:descriptor.descriptor_id,connectorId:connector.connector_id,activitySubjectId:agent.entity_id,payerEntityId:agent.entity_id,reservationId,billingDate:today,messages:[{role:'user',content:'hello'}],maxOutputTokens:32,maxChargeMicroE:'1000000'}),e=>e.code==='DAILY_FEE_REQUIRED');
    assert.equal(p.calls,0); assert.equal((await pool.query(`SELECT count(*)::int n FROM gateway.provider_requests`)).rows[0].n,0);
  }finally{await p.close();}
});

test('invalid reservation rejects before provider dispatch',async()=>{
  const p=await provider(async({res})=>success(res));
  try{
    const {descriptor,connector}=await configure({baseUrl:p.baseUrl}); const agent=await entity('AGENT','bad-reservation'); await mintTo(agent,'110000000','bad-reservation-seed'); await activate(agent);
    await assert.rejects(()=>infer(pool,{worldId:world,actorEntityId:agent.entity_id,idempotencyKey:'bad-reservation',descriptorId:descriptor.descriptor_id,connectorId:connector.connector_id,activitySubjectId:agent.entity_id,payerEntityId:agent.entity_id,reservationId:crypto.randomUUID(),billingDate:today,messages:[{role:'user',content:'hello'}],maxOutputTokens:32,maxChargeMicroE:'1000000'}),e=>e.code==='INVALID_RESERVATION');
    assert.equal(p.calls,0); assert.equal((await pool.query(`SELECT count(*)::int n FROM gateway.provider_requests`)).rows[0].n,0);
  }finally{await p.close();}
});

test('platform max charge must cover conservative request bound before dispatch',async()=>{
  const p=await provider(async({res})=>success(res));
  try{
    const {descriptor,connector}=await configure({baseUrl:p.baseUrl}); const agent=await entity('AGENT','small-auth'); await mintTo(agent,'110000000','small-auth-seed'); await activate(agent); const reservationId=await reserveFor(agent);
    await assert.rejects(()=>infer(pool,{worldId:world,actorEntityId:agent.entity_id,idempotencyKey:'small-auth',descriptorId:descriptor.descriptor_id,connectorId:connector.connector_id,activitySubjectId:agent.entity_id,payerEntityId:agent.entity_id,reservationId,billingDate:today,messages:[{role:'user',content:'hello'}],maxOutputTokens:32,maxChargeMicroE:'1'}),e=>e.code==='AUTHORIZATION_TOO_SMALL');
    assert.equal(p.calls,0); assert.equal((await pool.query(`SELECT count(*)::int n FROM gateway.provider_requests`)).rows[0].n,0);
  }finally{await p.close();}
});

test('ambiguous timeout becomes OUTCOME_UNKNOWN, retains reservation, and replay does not retry',async()=>{
  const p=await provider(async({res})=>{await new Promise(r=>setTimeout(r,300));success(res,{id:'late'});});
  try{
    const {descriptor,connector}=await configure({baseUrl:p.baseUrl,timeoutMs:100,supportsIdempotency:true,maxAttempts:3}); const agent=await entity('AGENT','timeout'); await mintTo(agent,'110000000','timeout-seed'); await activate(agent); const reservationId=await reserveFor(agent);
    const input={worldId:world,actorEntityId:agent.entity_id,idempotencyKey:'timeout-once',descriptorId:descriptor.descriptor_id,connectorId:connector.connector_id,activitySubjectId:agent.entity_id,payerEntityId:agent.entity_id,reservationId,billingDate:today,messages:[{role:'user',content:'slow'}],maxOutputTokens:32,maxChargeMicroE:'1000000'};
    const first=await infer(pool,input); assert.equal(first.status,'OUTCOME_UNKNOWN'); assert.equal(p.calls,1);
    const reservation=(await pool.query(`SELECT status FROM economy.reservations WHERE reservation_id=$1`,[reservationId])).rows[0]; assert.equal(reservation.status,'ACTIVE');
    assert.equal((await pool.query(`SELECT count(*)::int n FROM gateway.reconciliation_jobs WHERE execution_id=$1 AND status='PENDING'`,[first.executionId])).rows[0].n,1);
    const replay=await infer(pool,input); assert.equal(replay.replayed,true); assert.equal(replay.status,'OUTCOME_UNKNOWN'); assert.equal(p.calls,1);
  }finally{await p.close();}
});

test('retry is capped and reuses one provider idempotency key only when descriptor allows it',async()=>{
  const p=await provider(async({res,calls})=>{if(calls===1){res.writeHead(503,{'content-type':'application/json','retry-after':'0'});res.end(JSON.stringify({error:'temporary'}));}else success(res,{id:'retry-ok'});});
  try{
    const {descriptor,connector}=await configure({baseUrl:p.baseUrl,supportsIdempotency:true,maxAttempts:3}); const agent=await entity('AGENT','retry'); await mintTo(agent,'110000000','retry-seed'); await activate(agent); const reservationId=await reserveFor(agent);
    const out=await infer(pool,{worldId:world,actorEntityId:agent.entity_id,idempotencyKey:'retry-safe',descriptorId:descriptor.descriptor_id,connectorId:connector.connector_id,activitySubjectId:agent.entity_id,payerEntityId:agent.entity_id,reservationId,billingDate:today,messages:[{role:'user',content:'retry'}],maxOutputTokens:32,maxChargeMicroE:'1000000'});
    assert.equal(out.status,'SUCCEEDED'); assert.equal(p.calls,2); assert.ok(p.seen[0].headers['idempotency-key']); assert.equal(p.seen[0].headers['idempotency-key'],p.seen[1].headers['idempotency-key']);
    assert.equal((await pool.query(`SELECT count(*)::int n FROM gateway.execution_attempts WHERE execution_id=$1`,[out.executionId])).rows[0].n,2);
  }finally{await p.close();}
});

test('BYOK sends secret from environment reference, records usage, and does not double-charge Energy',async()=>{
  const secret='m06-test-secret'; process.env.M06_TEST_API_KEY=secret;
  const p=await provider(async({res})=>success(res,{input:7,output:4}));
  try{
    const {descriptor,connector}=await configure({baseUrl:p.baseUrl,billingMode:'BYOK',credentialEnvKey:'M06_TEST_API_KEY'}); const agent=await entity('AGENT','byok'); await mintTo(agent,'110000000','byok-seed'); await activate(agent);
    const before=await withTransaction(pool,(c)=>getWallet(c,world,agent.entity_id));
    const out=await infer(pool,{worldId:world,actorEntityId:agent.entity_id,idempotencyKey:'byok',descriptorId:descriptor.descriptor_id,connectorId:connector.connector_id,activitySubjectId:agent.entity_id,payerEntityId:agent.entity_id,billingDate:today,messages:[{role:'user',content:'hello'}],maxOutputTokens:32,maxChargeMicroE:'0'});
    const after=await withTransaction(pool,(c)=>getWallet(c,world,agent.entity_id)); assert.equal(out.status,'SUCCEEDED'); assert.equal(out.chargeMicroE,'0'); assert.equal(out.externalBilling,true); assert.equal(before.posted_balance_micro_e,after.posted_balance_micro_e); assert.equal(p.seen[0].headers.authorization,`Bearer ${secret}`);
    const receipt=(await pool.query(`SELECT external_billing,charge_micro_e FROM gateway.usage_receipts WHERE execution_id=$1`,[out.executionId])).rows[0]; assert.equal(receipt.external_billing,true); assert.equal(receipt.charge_micro_e,'0');
    const dbDump=JSON.stringify((await pool.query(`SELECT env_key FROM gateway.credential_refs`)).rows)+JSON.stringify(out); assert.equal(dbDump.includes(secret),false);
  }finally{delete process.env.M06_TEST_API_KEY;await p.close();}
});

test('confirmed provider failure with trustworthy usage still settles actual cost',async()=>{
  const p=await provider(async({res})=>{res.writeHead(400,{'content-type':'application/json','x-request-id':'failed-with-usage'});res.end(JSON.stringify({error:{message:'bad request after processing'},usage:{prompt_tokens:8,completion_tokens:2,total_tokens:10}}));});
  try{
    const {descriptor,connector}=await configure({baseUrl:p.baseUrl}); const agent=await entity('AGENT','failed-usage'); await mintTo(agent,'110000000','failed-usage-seed'); await activate(agent); const reservationId=await reserveFor(agent);
    const out=await infer(pool,{worldId:world,actorEntityId:agent.entity_id,idempotencyKey:'failed-usage',descriptorId:descriptor.descriptor_id,connectorId:connector.connector_id,activitySubjectId:agent.entity_id,payerEntityId:agent.entity_id,reservationId,billingDate:today,messages:[{role:'user',content:'fail'}],maxOutputTokens:32,maxChargeMicroE:'1000000'});
    assert.equal(out.status,'FAILED'); assert.equal(out.chargeMicroE,'12'); assert.ok(out.receiptId);
    const reservation=(await pool.query(`SELECT status,settled_amount_micro_e FROM economy.reservations WHERE reservation_id=$1`,[reservationId])).rows[0]; assert.equal(reservation.status,'SETTLED'); assert.equal(reservation.settled_amount_micro_e,'12');
  }finally{await p.close();}
});

test('cross-world descriptor reference is rejected before dispatch',async()=>{
  const p=await provider(async({res})=>success(res));
  try{
    const {descriptor,connector}=await configure({baseUrl:p.baseUrl});
    const otherSystem=await withTransaction(pool,(c)=>createEntity(c,{worldId:'other-world',entityType:'SYSTEM',displayId:'other-system',name:'Other System'}));
    const other=await entity('AGENT','other','other-world',otherSystem); await mintTo(other,'110000000','other-seed','other-world',otherSystem); await activate(other);
    await assert.rejects(()=>infer(pool,{worldId:'other-world',actorEntityId:other.entity_id,idempotencyKey:'cross-world',descriptorId:descriptor.descriptor_id,connectorId:connector.connector_id,activitySubjectId:other.entity_id,payerEntityId:other.entity_id,billingDate:today,messages:[{role:'user',content:'no'}],maxOutputTokens:16,maxChargeMicroE:'0'}),e=>e.code==='GATEWAY_NOT_AVAILABLE');
    assert.equal(p.calls,0);
  }finally{await p.close();}
});
