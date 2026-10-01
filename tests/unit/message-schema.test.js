import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const here=path.dirname(fileURLToPath(import.meta.url));
const schemaDir=path.resolve(here,'../../schemas');
const ajv=new Ajv2020({allErrors:true,strict:true});
addFormats(ajv);

function compile(name){
  return ajv.compile(JSON.parse(fs.readFileSync(path.join(schemaDir,name),'utf8')));
}

const validateThread=compile('thread.schema.json');
const validateMessage=compile('message.schema.json');
const validateReceipt=compile('message-receipt.schema.json');

const ids={
  thread:'00000000-0000-4000-8000-000000000001',
  message:'00000000-0000-4000-8000-000000000002',
  receipt:'00000000-0000-4000-8000-000000000003',
  sender:'00000000-0000-4000-8000-000000000004',
  recipient:'00000000-0000-4000-8000-000000000005',
  target:'00000000-0000-4000-8000-000000000006',
};

const thread={
  schema_version:'nh.v3.0',
  thread_id:ids.thread,
  world_id:'world-1',
  created_by:ids.sender,
  participant_entity_ids:[ids.sender,ids.recipient],
  causation_id:null,
  correlation_id:'conversation-1',
  version:1,
  created_at:'2026-10-01T06:00:00Z',
};

const message={
  schema_version:'nh.v3.0',
  message_id:ids.message,
  thread_id:ids.thread,
  sender:ids.sender,
  recipients:[ids.recipient],
  type:'NATURAL_LANGUAGE',
  version:1,
  reply_to:null,
  causation_id:null,
  correlation_id:'conversation-1',
  created_at:'2026-10-01T06:01:00Z',
  expires_at:null,
  content_ref:'object-version-1',
  delivery_status:'SENT',
  idempotency_key:'send-1',
};

const receipt={
  schema_version:'nh.v3.0',
  receipt_id:ids.receipt,
  message_id:ids.message,
  thread_id:ids.thread,
  sender:ids.sender,
  recipient:ids.recipient,
  status:'DELIVERED',
  version:1,
  causation_id:ids.message,
  correlation_id:'conversation-1',
  recorded_at:'2026-10-01T06:02:00Z',
};

test('thread schema requires explicit causation, correlation, and version',()=>{
  assert.equal(validateThread(thread),true,JSON.stringify(validateThread.errors));
  for(const field of ['causation_id','correlation_id','version']){
    const candidate={...thread};
    delete candidate[field];
    assert.equal(validateThread(candidate),false,`${field} must be explicit`);
  }
});

test('message schema accepts every delivery state defined by M04',()=>{
  for(const delivery_status of ['SENT','DELIVERED','OBSERVED','REJECTED','EXPIRED']){
    const candidate={...message,delivery_status};
    assert.equal(validateMessage(candidate),true,`${delivery_status}: ${JSON.stringify(validateMessage.errors)}`);
  }
});

test('message delivery status rejects ACCEPTED',()=>{
  assert.equal(validateMessage({...message,delivery_status:'ACCEPTED'}),false);
});

test('message schema requires sender, recipients, causation, correlation, and version',()=>{
  for(const field of ['sender','recipients','causation_id','correlation_id','version']){
    const candidate={...message};
    delete candidate[field];
    assert.equal(validateMessage(candidate),false,`${field} must be explicit`);
  }
});

test('receipt schema accepts ordinary delivery states without domain acceptance',()=>{
  for(const status of ['SENT','DELIVERED','OBSERVED','REJECTED','EXPIRED']){
    const candidate={...receipt,status};
    assert.equal(validateReceipt(candidate),true,`${status}: ${JSON.stringify(validateReceipt.errors)}`);
  }
});

test('ACCEPTED receipt is valid only for an explicitly versioned offer, invitation, or contract',()=>{
  for(const kind of ['OFFER','INVITATION','CONTRACT']){
    const candidate={...receipt,status:'ACCEPTED',accepted_target:{kind,id:ids.target,version:2}};
    assert.equal(validateReceipt(candidate),true,`${kind}: ${JSON.stringify(validateReceipt.errors)}`);
  }

  assert.equal(validateReceipt({...receipt,status:'ACCEPTED'}),false,'ACCEPTED without a target must fail');
  assert.equal(validateReceipt({...receipt,status:'ACCEPTED',accepted_target:{kind:'MESSAGE',id:ids.target,version:2}}),false,'generic message acceptance must fail');
  assert.equal(validateReceipt({...receipt,status:'ACCEPTED',accepted_target:{kind:'OFFER',id:ids.target}}),false,'acceptance without target version must fail');
  assert.equal(validateReceipt({...receipt,status:'ACCEPTED',accepted_target:{kind:'OFFER',id:ids.target,version:0}}),false,'non-positive target version must fail');
  assert.equal(validateReceipt({...receipt,status:'OBSERVED',accepted_target:{kind:'OFFER',id:ids.target,version:2}}),false,'read receipt must not carry acceptance');
});

test('receipt schema requires explicit sender, recipient, causation, correlation, and version',()=>{
  for(const field of ['sender','recipient','causation_id','correlation_id','version']){
    const candidate={...receipt};
    delete candidate[field];
    assert.equal(validateReceipt(candidate),false,`${field} must be explicit`);
  }
});
