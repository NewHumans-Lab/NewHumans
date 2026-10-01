import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createPool, withTransaction } from '../../src/db.js';
import { createEntity } from '../../src/services/core.js';

const pool=createPool();
const world='test-m04-messaging';
let system;

async function reset(){
  await pool.query('TRUNCATE social.message_receipts, social.message_recipients, social.messages, social.thread_participants, social.threads, social.contact_preferences, core.entities RESTART IDENTITY CASCADE');
  system=await withTransaction(pool,(c)=>createEntity(c,{worldId:world,entityType:'SYSTEM',displayId:'m04-system',name:'M04 System'}));
}

async function entity(type,name){
  return withTransaction(pool,(c)=>createEntity(c,{worldId:world,entityType:type,displayId:`${name}-${crypto.randomUUID()}`,name,createdBy:system.entity_id},{actorEntityId:system.entity_id}));
}

async function makeThread(sender,recipients){
  const threadId=crypto.randomUUID();
  const correlationId=`conversation-${threadId}`;
  await pool.query(
    "INSERT INTO social.threads(world_id,thread_id,thread_kind,created_by,causation_id,correlation_id) VALUES ($1,$2,'GROUP',$3,NULL,$4)",
    [world,threadId,sender.entity_id,correlationId],
  );
  for(const member of [sender,...recipients]){
    await pool.query(
      'INSERT INTO social.thread_participants(world_id,thread_id,entity_id) VALUES ($1,$2,$3)',
      [world,threadId,member.entity_id],
    );
  }
  return {threadId,correlationId};
}

async function putMessage({messageId,threadId,correlationId,sender,recipients,contentRef='object-version-1',idempotencyKey=`send-${messageId}`}){
  return pool.query(
    'SELECT (social.put_message($1,$2,$3,$4,$5::uuid[],$6,$7,$8,$9,$10)).*',
    [world,messageId,threadId,sender.entity_id,recipients.map((r)=>r.entity_id),'NATURAL_LANGUAGE',1,contentRef,idempotencyKey,correlationId],
  );
}

async function recordReceipt({receiptId,messageId,recipient,status,correlationId,causationId=null,acceptedTarget=null}){
  if(!acceptedTarget){
    return pool.query(
      'SELECT (social.record_message_receipt($1,$2,$3,$4,$5,$6,$7,$8)).*',
      [world,receiptId,messageId,recipient.entity_id,status,1,correlationId,causationId],
    );
  }
  return pool.query(
    'SELECT (social.record_message_receipt($1,$2,$3,$4,$5,$6,$7,$8,NULL,$9,$10,$11)).*',
    [world,receiptId,messageId,recipient.entity_id,status,1,correlationId,causationId,acceptedTarget.kind,acceptedTarget.id,acceptedTarget.version],
  );
}

test.beforeEach(reset);
test.after(async()=>pool.end());

test('stable message_id is idempotent, including after thread closure, and conflicting reuse is rejected',async()=>{
  const sender=await entity('AGENT','sender');
  const recipient=await entity('HUMAN','recipient');
  const {threadId,correlationId}=await makeThread(sender,[recipient]);
  const messageId=crypto.randomUUID();

  const first=await putMessage({messageId,threadId,correlationId,sender,recipients:[recipient]});
  const replay=await putMessage({messageId,threadId,correlationId,sender,recipients:[recipient]});
  assert.equal(first.rows[0].message_id,messageId);
  assert.equal(first.rows[0].schema_version,'nh.v3.0');
  assert.equal(replay.rows[0].message_id,messageId);
  assert.equal((await pool.query('SELECT count(*)::int n FROM social.messages WHERE world_id=$1 AND message_id=$2',[world,messageId])).rows[0].n,1);
  assert.equal((await pool.query('SELECT count(*)::int n FROM social.message_recipients WHERE world_id=$1 AND message_id=$2',[world,messageId])).rows[0].n,1);

  await pool.query(
    "UPDATE social.threads SET thread_state='CLOSED',closed_at=now(),version=2 WHERE world_id=$1 AND thread_id=$2",
    [world,threadId],
  );
  const closedReplay=await putMessage({messageId,threadId,correlationId,sender,recipients:[recipient]});
  assert.equal(closedReplay.rows[0].message_id,messageId,'exact replay must not depend on later thread state');

  await assert.rejects(
    ()=>putMessage({messageId,threadId,correlationId,sender,recipients:[recipient],contentRef:'object-version-2'}),
    (error)=>error.code==='23505',
  );
});

test('message idempotency_key cannot be reused for a different message_id',async()=>{
  const sender=await entity('AGENT','sender');
  const recipient=await entity('HUMAN','recipient');
  const {threadId,correlationId}=await makeThread(sender,[recipient]);
  const idempotencyKey='stable-send-key';
  await putMessage({messageId:crypto.randomUUID(),threadId,correlationId,sender,recipients:[recipient],idempotencyKey});
  await assert.rejects(
    ()=>putMessage({messageId:crypto.randomUUID(),threadId,correlationId,sender,recipients:[recipient],idempotencyKey}),
    (error)=>error.code==='23505',
  );
});

test('duplicate receipts are idempotent and ACCEPTED is explicit domain acceptance, never delivery inference',async()=>{
  const sender=await entity('AGENT','sender');
  const recipient=await entity('HUMAN','recipient');
  const {threadId,correlationId}=await makeThread(sender,[recipient]);
  const messageId=crypto.randomUUID();
  await putMessage({messageId,threadId,correlationId,sender,recipients:[recipient]});

  const target={kind:'OFFER',id:crypto.randomUUID(),version:2};
  await assert.rejects(
    ()=>recordReceipt({receiptId:crypto.randomUUID(),messageId,recipient,status:'ACCEPTED',correlationId}),
    (error)=>error.code==='23514',
  );
  const accepted=await recordReceipt({receiptId:crypto.randomUUID(),messageId,recipient,status:'ACCEPTED',correlationId,causationId:messageId,acceptedTarget:target});
  assert.equal(accepted.rows[0].receipt_status,'ACCEPTED');
  assert.equal(accepted.rows[0].accepted_target_kind,'OFFER');
  assert.equal(accepted.rows[0].sender_entity_id,sender.entity_id);

  const acceptedOnly=(await pool.query(
    'SELECT delivery_status FROM social.message_delivery_states WHERE world_id=$1 AND message_id=$2 AND recipient_entity_id=$3',
    [world,messageId,recipient.entity_id],
  )).rows[0];
  assert.equal(acceptedOnly.delivery_status,'SENT','domain acceptance must not mutate delivery state');

  const deliveredId=crypto.randomUUID();
  const delivered=await recordReceipt({receiptId:deliveredId,messageId,recipient,status:'DELIVERED',correlationId,causationId:messageId});
  const duplicate=await recordReceipt({receiptId:crypto.randomUUID(),messageId,recipient,status:'DELIVERED',correlationId,causationId:messageId});
  assert.equal(delivered.rows[0].receipt_id,deliveredId);
  assert.equal(duplicate.rows[0].receipt_id,deliveredId,'semantic duplicate must return the existing receipt');
  assert.equal((await pool.query("SELECT count(*)::int n FROM social.message_receipts WHERE world_id=$1 AND message_id=$2 AND receipt_status='DELIVERED'",[world,messageId])).rows[0].n,1);

  await recordReceipt({receiptId:crypto.randomUUID(),messageId,recipient,status:'OBSERVED',correlationId,causationId:messageId});
  const observed=(await pool.query(
    'SELECT delivery_status FROM social.message_delivery_states WHERE world_id=$1 AND message_id=$2 AND recipient_entity_id=$3',
    [world,messageId,recipient.entity_id],
  )).rows[0];
  assert.equal(observed.delivery_status,'OBSERVED');
  assert.equal((await pool.query("SELECT count(*)::int n FROM social.message_receipts WHERE world_id=$1 AND message_id=$2 AND receipt_status='ACCEPTED'",[world,messageId])).rows[0].n,1);

  await assert.rejects(
    ()=>recordReceipt({receiptId:crypto.randomUUID(),messageId,recipient,status:'OBSERVED',correlationId,acceptedTarget:target}),
    (error)=>error.code==='23514',
  );
});

test('invalid sender is rejected by the physical sender foreign key',async()=>{
  const sender=await entity('AGENT','sender');
  const recipient=await entity('HUMAN','recipient');
  const {threadId,correlationId}=await makeThread(sender,[recipient]);
  const invalidSender=crypto.randomUUID();
  await assert.rejects(
    ()=>pool.query(
      `INSERT INTO social.messages(
         world_id,message_id,thread_id,sender_entity_id,message_type,version,
         correlation_id,content_ref,idempotency_key
       ) VALUES ($1,$2,$3,$4,'NATURAL_LANGUAGE',1,$5,'object-version-1',$6)`,
      [world,crypto.randomUUID(),threadId,invalidSender,correlationId,`invalid-${crypto.randomUUID()}`],
    ),
    (error)=>error.code==='23503',
  );
});

test('contact, thread, participant, message and receipt state constraints remain closed',async()=>{
  const sender=await entity('AGENT','sender');
  const recipient=await entity('HUMAN','recipient');
  await pool.query('INSERT INTO social.contact_preferences(world_id,entity_id) VALUES ($1,$2)',[world,sender.entity_id]);
  await assert.rejects(
    ()=>pool.query('UPDATE social.contact_preferences SET max_unknown_messages_per_hour=-1, version=2 WHERE world_id=$1 AND entity_id=$2',[world,sender.entity_id]),
    (error)=>error.code==='23514',
  );

  const {threadId,correlationId}=await makeThread(sender,[recipient]);
  await assert.rejects(
    ()=>pool.query("UPDATE social.threads SET thread_state='DELIVERED',version=2 WHERE world_id=$1 AND thread_id=$2",[world,threadId]),
    (error)=>error.code==='23514',
  );
  await assert.rejects(
    ()=>pool.query("UPDATE social.thread_participants SET participant_state='LEFT' WHERE world_id=$1 AND thread_id=$2 AND entity_id=$3",[world,threadId,recipient.entity_id]),
    (error)=>error.code==='23514',
  );

  const messageId=crypto.randomUUID();
  await putMessage({messageId,threadId,correlationId,sender,recipients:[recipient]});
  await assert.rejects(
    ()=>recordReceipt({receiptId:crypto.randomUUID(),messageId,recipient,status:'READ',correlationId}),
    (error)=>error.code==='23514',
  );
});

test('messaging migration reuses Directory contact authority and contains no funding authority',()=>{
  const sql=fs.readFileSync(new URL('../../migrations/0501_m04_messaging_data.sql',import.meta.url),'utf8');
  const executableSql=sql.replace(/--.*$/gm,'');
  assert.doesNotMatch(executableSql,/CREATE\s+TABLE\s+social\.contact_preferences/i);
  assert.doesNotMatch(executableSql,/\beconomy\.|\bwallets?\b|\bmicro_e\b|\breservations?\b|\bescrow\b|\bsettlement\b/i);
});
