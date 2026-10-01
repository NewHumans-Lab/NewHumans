import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const schema=JSON.parse(fs.readFileSync(new URL('../../schemas/relationship.schema.json',import.meta.url),'utf8'));
const ajv=new Ajv2020({allErrors:true,strict:true});
addFormats(ajv);
const validate=ajv.compile(schema);

const id=(n)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const at='2026-10-01T06:00:00Z';

function relationship(overrides={}){
  return {
    relationship_id:id(1),
    world_id:'world-1',
    subject_entity_id:id(2),
    object_entity_id:id(3),
    relationship_type:'considers_friend',
    state:{status:'ACTIVE',dispute_status:'NONE',changed_at:at},
    time:{created_at:at,valid_from:at,valid_until:null},
    provenance:{
      source_kind:'ENTITY_DECLARATION',
      records:[{record_type:'DECLARATION',record_id:'declaration-1',participant_role:'SUBJECT',occurred_at:at}],
    },
    ...overrides,
  };
}

test('unilateral relationship requires the subject declaration as provenance',()=>{
  assert.equal(validate(relationship()),true,JSON.stringify(validate.errors));

  const objectDeclared=relationship({
    provenance:{
      source_kind:'ENTITY_DECLARATION',
      records:[{record_type:'DECLARATION',record_id:'declaration-2',participant_role:'OBJECT',occurred_at:at}],
    },
  });
  assert.equal(validate(objectDeclared),false,'the object cannot manufacture the subject unilateral declaration');
});

test('mutual friendship requires two-sided confirmation and rejects unilateral provenance',()=>{
  const mutual=relationship({
    relationship_type:'mutual_friendship',
    provenance:{
      source_kind:'MUTUAL_CONFIRMATION',
      records:[
        {record_type:'CONFIRMATION',record_id:'confirmation-subject',participant_role:'SUBJECT',occurred_at:at},
        {record_type:'CONFIRMATION',record_id:'confirmation-object',participant_role:'OBJECT',occurred_at:at},
      ],
    },
  });
  assert.equal(validate(mutual),true,JSON.stringify(validate.errors));

  const oneSided=structuredClone(mutual);
  oneSided.provenance.records.pop();
  assert.equal(validate(oneSided),false,'one confirmation must not establish a mutual relationship');

  const unilateralSource=relationship({relationship_type:'mutual_friendship'});
  assert.equal(validate(unilateralSource),false,'a unilateral declaration must not be promoted to mutual friendship');
});

test('provenance is mandatory and source kind is bound to process-derived relationship types',()=>{
  const missing=relationship();
  delete missing.provenance;
  assert.equal(validate(missing),false,'relationship records without provenance must be rejected');

  const workedWith=relationship({
    relationship_type:'worked_with',
    provenance:{
      source_kind:'CONTRACT',
      records:[{record_type:'CONTRACT',record_id:'contract-1',record_version:1,occurred_at:at}],
    },
  });
  assert.equal(validate(workedWith),true,JSON.stringify(validate.errors));
  workedWith.provenance.source_kind='ENTITY_DECLARATION';
  assert.equal(validate(workedWith),false,'worked_with cannot be sourced from self-declaration');
});

test('state and validity time stay explicit, and ended relationships require valid_until',()=>{
  const ended=relationship({
    state:{status:'ENDED',dispute_status:'RESOLVED',changed_at:at},
    time:{created_at:at,valid_from:at,valid_until:'2026-10-01T07:00:00Z'},
  });
  assert.equal(validate(ended),true,JSON.stringify(validate.errors));

  ended.time.valid_until=null;
  assert.equal(validate(ended),false,'ENDED relationship must carry its validity end time');
});
