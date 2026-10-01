import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const entityId='00000000-0000-4000-8000-000000000001';
const profileId='00000000-0000-4000-8000-000000000002';
const evidenceId='00000000-0000-4000-8000-000000000003';

function validator(file){
  const ajv=new Ajv2020({allErrors:true,strict:true});
  addFormats(ajv);
  return ajv.compile(JSON.parse(fs.readFileSync(new URL(`../../schemas/${file}`,import.meta.url),'utf8')));
}

const profile={
  schema_version:'nh.v3.0',
  profile_id:profileId,
  world_id:'world-1',
  entity_id:entityId,
  headline:'PostgreSQL reliability engineer',
  summary:'Available for bounded debugging and verification work.',
  services:[{
    service_key:'postgres-debug',
    title:'PostgreSQL root-cause debugging',
    description:'Reproduce, isolate, and document database failures.',
    domains:['postgresql','debugging'],
  }],
  availability:{status:'AVAILABLE',available_from:null,note:null},
  collaboration_preferences:{languages:['en','zh-CN'],task_domains:['postgresql'],work_modes:['ASYNC']},
  contact_rules:{allow_unknown_senders:true,accepts_inbound_offers:true,allowed_message_types:['INBOUND_OFFER']},
  accepts_new_work:true,
  created_at:'2026-10-01T00:00:00Z',
  updated_at:'2026-10-01T00:00:00Z',
};

const evidence={
  schema_version:'nh.v3.0',
  evidence_id:evidenceId,
  world_id:'world-1',
  entity_id:entityId,
  evidence_type:'AUTOMATED_TEST',
  task_domain:'postgresql',
  task_difficulty:'integration',
  input_ref:'artifact://test-fixture/42',
  environment:{description:'PostgreSQL 16 isolated test database',model_reference:null,tool_references:['node:test']},
  sample_size:12,
  outcome:{status:'PASS',summary:'12/12 isolated regression cases passed.'},
  rework_count:1,
  duration_ms:42000,
  cost_micro_e:'125000',
  reproduction_status:'REPRODUCED',
  interest_relationships:[],
  source_ref:'artifact://test-report/42',
  work_object_id:null,
  contract_id:null,
  reviewer_entity_id:null,
  created_at:'2026-10-01T00:00:00Z',
};

test('directory profile schema accepts a standalone API/mock profile',()=>{
  const validate=validator('directory-profile.schema.json');
  assert.equal(validate(profile),true,JSON.stringify(validate.errors));
});

test('directory profile schema rejects local economy state and malformed availability',()=>{
  const validate=validator('directory-profile.schema.json');
  assert.equal(validate({...profile,economy:{balance_micro_e:'1000000'}}),false);
  assert.equal(validate({...profile,availability:{status:'SLEEPING'}}),false);
});

test('directory evidence schema accepts scoped evidence without an economy object',()=>{
  const validate=validator('directory-evidence.schema.json');
  assert.equal(validate(evidence),true,JSON.stringify(validate.errors));
});

test('directory evidence schema rejects impossible counts and embedded wallet state',()=>{
  const validate=validator('directory-evidence.schema.json');
  assert.equal(validate({...evidence,sample_size:0}),false);
  assert.equal(validate({...evidence,rework_count:-1}),false);
  assert.equal(validate({...evidence,wallet:{available_micro_e:'1'}}),false);
});

test('directory aggregate schema accepts identity/runtime display hints and evidence',()=>{
  const validate=validator('directory.schema.json');
  const entry={
    schema_version:'nh.v3.0',
    world_id:'world-1',
    entity:{
      entity_id:entityId,
      display_name:'Agent Atlas',
      entity_type:'AGENT',
      identity_status:'ACTIVE',
      source_module:'M01',
    },
    profile:{
      profile_id:profile.profile_id,
      entity_id:profile.entity_id,
      headline:profile.headline,
      summary:profile.summary,
      services:profile.services,
      availability:profile.availability,
      collaboration_preferences:profile.collaboration_preferences,
      contact_rules:profile.contact_rules,
      accepts_new_work:profile.accepts_new_work,
      updated_at:profile.updated_at,
    },
    activity_hint:{state:'DORMANT',source_module:'M02',observed_at:'2026-10-01T00:00:00Z'},
    evidence:[{
      evidence_id:evidence.evidence_id,
      entity_id:evidence.entity_id,
      evidence_type:evidence.evidence_type,
      task_domain:evidence.task_domain,
      task_difficulty:evidence.task_difficulty,
      sample_size:evidence.sample_size,
      outcome:evidence.outcome,
      rework_count:evidence.rework_count,
      duration_ms:evidence.duration_ms,
      cost_micro_e:evidence.cost_micro_e,
      reproduction_status:evidence.reproduction_status,
      interest_relationships:evidence.interest_relationships,
      source_ref:evidence.source_ref,
      created_at:evidence.created_at,
    }],
  };
  assert.equal(validate(entry),true,JSON.stringify(validate.errors));
  assert.equal(validate({...entry,economy:{wallet_id:'local-copy'}}),false);
  assert.equal(validate({...entry,entity:{...entry.entity,source_module:'M04'}}),false);
});
