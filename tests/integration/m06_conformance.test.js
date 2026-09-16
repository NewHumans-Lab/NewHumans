import http from 'node:http';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPool, withTransaction } from '../../src/db.js';
import { createEntity, runCommand } from '../../src/services/core.js';
import { firstActivation, mint, reserve } from '../../src/services/economy.js';
import { infer, registerConnector, registerDescriptor } from '../../src/services/gateway.js';

const pool=createPool();
const world='gateway-conformance';
const today=new Date().toISOString().slice(0,10);
let system;

async function reset(){
  await pool.query(`TRUNCATE gateway.reconciliation_jobs,gateway.usage_receipts,gateway.provider_requests,gateway.execution_attempts,gateway.executions,gateway.connector_configs,gateway.credential_refs,gateway.capability_descriptors,core.consumer_receipts,core.outbox,core.life_events,economy.activity_fees,economy.activity_subjects,economy.reservations,economy.postings,economy.journals,economy.wallets,core.actions,core.capability_grants,core.entities RESTART IDENTITY CASCADE`);
  system=await withTransaction(pool,(c)=>createEntity(c,{worldId:world,entityType:'SYSTEM',displayId:'system',name:'System'}));
}
async function agent(name,amount='110000000'){
  const a=await withTransaction(pool,(c)=>createEntity(c,{worldId:world,entityType:'AGENT',displayId:`${name}-${crypto.randomUUID()}`,name,createdBy:system.entity_id},{actorEntityId:system.entity_id}));
  await runCommand(pool,{worldId:world,actorEntityId:system.entity_id,actionType:'economy.mint',idempotencyKey:`mint-${a.entity_id}`,payload:{amount}},(c,ctx)=>mint(c,{worldId:world,targetEntityId:a.entity_id,amountMicroE:amount,basisKey:`basis-${a.entity_id}`,actorEntityId:system.entity_id,actionId:ctx.actionId}));
  await runCommand(pool,{worldId:world,actorEntityId:a.entity_id,actionType:'economy.first_activation',idempotencyKey:`activate-${a.entity_id}`,payload:{today}},(c,ctx)=>firstActivation(c,{worldId:world,entityId:a.entity_id,billingDate:today,actorEntityId:a.entity_id,actionId:ctx.actionId}));
  return a;
}
async function reserveFor(a,amount='1000000'){
  const out=await runCommand(pool,{worldId:world,actorEntityId:a.entity_id,actionType:'economy.reserve',idempotencyKey:`reserve-${crypto.randomUUID()}`,payload:{amount}},(c,ctx)=>reserve(c,{worldId:world,entityId:a.entity_id,amountMicroE:amount,businessKey:`budget-${crypto.randomUUID()}`,actorEntityId:a.entity_id,actionId:ctx.actionId}));
  return out.result.reservationId;
}
async function configure({baseUrl,maxInputTokens=4096,maxOutputTokens=256,supportsIdempotency=false,maxAttempts=1}={}){
  return withTransaction(pool,async(c)=>{
    const descriptor=await registerDescriptor(c,{worldId:world,actorEntityId:system.entity_id,descriptorKey:`model-${crypto.randomUUID()}`,modelReference:'test-model',maxInputTokens,maxOutputTokens,timeoutMs:1000,maxAttempts,supportsIdempotency,inputRateMicroEPerMillion:'1000000',outputRateMicroEPerMillion:'2000000'});
    const connector=await registerConnector(c,{worldId:world,actorEntityId:system.entity_id,descriptorId:descriptor.descriptor_id,connectorKind:'LOCAL_SELF_HOSTED',billingMode:'PLATFORM_PREPAID',baseUrl});
    return{descriptor,connector};
  });
}
async function provider(handler){
  let calls=0;
  const server=http.createServer(async(req,res)=>{calls++;for await(const _ of req){} await handler({res,calls});});
  await new Promise((resolve)=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();
  return{baseUrl:`http://127.0.0.1:${address.port}/`,get calls(){return calls},close:()=>new Promise((resolve)=>server.close(resolve))};
}
function success(res,{input=8,output=2,text='ok'}={}){res.writeHead(200,{'content-type':'application/json','x-request-id':'conformance'});res.end(JSON.stringify({id:'conformance',choices:[{message:{content:text}}],usage:{prompt_tokens:input,completion_tokens:output,total_tokens:input+output}}));}
function inferenceInput(a,descriptor,connector,reservationId,overrides={}){
  return{worldId:world,actorEntityId:a.entity_id,idempotencyKey:`infer-${crypto.randomUUID()}`,descriptorId:descriptor.descriptor_id,connectorId:connector.connector_id,activitySubjectId:a.entity_id,payerEntityId:a.entity_id,reservationId,billingDate:today,messages:[{role:'user',content:'hello'}],maxOutputTokens:32,maxChargeMicroE:'1000000',...overrides};
}

test.beforeEach(reset);
test.after(async()=>pool.end());

test('descriptor max_input_tokens is enforced before provider dispatch',async()=>{
  const p=await provider(async({res})=>success(res));
  try{
    const {descriptor,connector}=await configure({baseUrl:p.baseUrl,maxInputTokens:64}); const a=await agent('input-limit'); const reservationId=await reserveFor(a);
    await assert.rejects(()=>infer(pool,inferenceInput(a,descriptor,connector,reservationId,{messages:[{role:'user',content:'x'.repeat(200)}]})),e=>e.code==='MODEL_INPUT_LIMIT_EXCEEDED');
    assert.equal(p.calls,0);
  }finally{await p.close();}
});

test('a retry cannot reuse yesterday activity qualification',async()=>{
  const p=await provider(async({res})=>{res.writeHead(503,{'content-type':'application/json','retry-after':'0'});res.end(JSON.stringify({error:'temporary'}));});
  try{
    const {descriptor,connector}=await configure({baseUrl:p.baseUrl,supportsIdempotency:true,maxAttempts:3}); const a=await agent('date-rollover'); const reservationId=await reserveFor(a);
    const firstNow=new Date(`${today}T12:00:00.000Z`); const nextNow=new Date(firstNow.getTime()+86_400_000); let clockCalls=0;
    const out=await infer(pool,inferenceInput(a,descriptor,connector,reservationId),{now:()=>clockCalls++===0?firstNow:nextNow});
    assert.equal(out.status,'FAILED'); assert.equal(out.error,'STALE_ACTIVITY_TICKET'); assert.equal(out.dispatchedBefore,true); assert.equal(p.calls,1);
    const reservation=(await pool.query('SELECT status FROM economy.reservations WHERE reservation_id=$1',[reservationId])).rows[0]; assert.equal(reservation.status,'RELEASED');
  }finally{await p.close();}
});

test('zero available Energy after reservation blocks the first provider attempt',async()=>{
  const p=await provider(async({res})=>success(res));
  try{
    const {descriptor,connector}=await configure({baseUrl:p.baseUrl}); const a=await agent('zero-available','100000000'); const reservationId=await reserveFor(a,'99000000');
    const out=await infer(pool,inferenceInput(a,descriptor,connector,reservationId));
    assert.equal(out.status,'FAILED'); assert.equal(out.error,'NO_AVAILABLE_ENERGY'); assert.equal(p.calls,0);
  }finally{await p.close();}
});

test('retry rechecks current actor and stops after suspension',async()=>{
  let actorId;
  const p=await provider(async({res,calls})=>{if(calls===1){await pool.query("UPDATE core.entities SET identity_status='SUSPENDED' WHERE entity_id=$1",[actorId]);res.writeHead(503,{'content-type':'application/json','retry-after':'0'});res.end(JSON.stringify({error:'temporary'}));}else success(res);});
  try{
    const {descriptor,connector}=await configure({baseUrl:p.baseUrl,supportsIdempotency:true,maxAttempts:3}); const a=await agent('suspend'); actorId=a.entity_id; const reservationId=await reserveFor(a);
    const out=await infer(pool,inferenceInput(a,descriptor,connector,reservationId));
    assert.equal(out.status,'FAILED'); assert.equal(out.error,'UNAUTHENTICATED'); assert.equal(out.dispatchedBefore,true); assert.equal(p.calls,1);
  }finally{await p.close();}
});

test('retry rechecks descriptor and connector availability',async()=>{
  let descriptorId;
  const p=await provider(async({res,calls})=>{if(calls===1){await pool.query("UPDATE gateway.capability_descriptors SET status='DISABLED' WHERE descriptor_id=$1",[descriptorId]);res.writeHead(503,{'content-type':'application/json','retry-after':'0'});res.end(JSON.stringify({error:'temporary'}));}else success(res);});
  try{
    const configured=await configure({baseUrl:p.baseUrl,supportsIdempotency:true,maxAttempts:3}); descriptorId=configured.descriptor.descriptor_id; const a=await agent('route-disable'); const reservationId=await reserveFor(a);
    const out=await infer(pool,inferenceInput(a,configured.descriptor,configured.connector,reservationId));
    assert.equal(out.status,'FAILED'); assert.equal(out.error,'GATEWAY_NOT_AVAILABLE'); assert.equal(p.calls,1);
  }finally{await p.close();}
});

test('known usage with malformed successful output is settled and recorded',async()=>{
  const p=await provider(async({res})=>{res.writeHead(200,{'content-type':'application/json','x-request-id':'bad-output'});res.end(JSON.stringify({id:'bad-output',choices:[{message:{}}],usage:{prompt_tokens:8,completion_tokens:2,total_tokens:10}}));});
  try{
    const {descriptor,connector}=await configure({baseUrl:p.baseUrl}); const a=await agent('bad-output'); const reservationId=await reserveFor(a);
    const out=await infer(pool,inferenceInput(a,descriptor,connector,reservationId));
    assert.equal(out.status,'FAILED'); assert.equal(out.error,'INVALID_PROVIDER_RESPONSE'); assert.equal(out.chargeMicroE,'12'); assert.ok(out.receiptId);
    const reservation=(await pool.query('SELECT status,settled_amount_micro_e FROM economy.reservations WHERE reservation_id=$1',[reservationId])).rows[0]; assert.equal(reservation.status,'SETTLED'); assert.equal(reservation.settled_amount_micro_e,'12');
  }finally{await p.close();}
});

test('provider output above requested maximum is a billed protocol failure',async()=>{
  const p=await provider(async({res})=>success(res,{input:8,output:6}));
  try{
    const {descriptor,connector}=await configure({baseUrl:p.baseUrl}); const a=await agent('output-limit'); const reservationId=await reserveFor(a);
    const out=await infer(pool,inferenceInput(a,descriptor,connector,reservationId,{maxOutputTokens:5}));
    assert.equal(out.status,'FAILED'); assert.equal(out.error,'PROVIDER_OUTPUT_LIMIT_EXCEEDED'); assert.equal(out.chargeMicroE,'20'); assert.ok(out.receiptId);
  }finally{await p.close();}
});

test('purpose and temperature are validated before execution is created',async()=>{
  const p=await provider(async({res})=>success(res));
  try{
    const {descriptor,connector}=await configure({baseUrl:p.baseUrl}); const a=await agent('input-contract'); const reservationId=await reserveFor(a);
    await assert.rejects(()=>infer(pool,inferenceInput(a,descriptor,connector,reservationId,{actionPurpose:'MAKE_ME_ADMIN'})),e=>e.code==='INVALID_ACTION_PURPOSE');
    await assert.rejects(()=>infer(pool,inferenceInput(a,descriptor,connector,reservationId,{temperature:'hot'})),e=>e.code==='INVALID_GATEWAY_INPUT');
    assert.equal(p.calls,0);
  }finally{await p.close();}
});
