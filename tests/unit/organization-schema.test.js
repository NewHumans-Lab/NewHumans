import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const schema=JSON.parse(fs.readFileSync(new URL('../../schemas/organization.schema.json',import.meta.url),'utf8'));
const ajv=new Ajv2020({allErrors:true,strict:true});
addFormats(ajv);
const validate=ajv.compile(schema);

function validOrganization(){
  return {
    schema_version:'nh.v3.0',
    organization_id:'00000000-0000-4000-8000-000000000100',
    world_id:'world-1',
    entity_type:'ORGANIZATION',
    version:1,
    charter:{
      version:1,
      purpose:'Coordinate a shared project under an explicit charter.',
      signing_threshold:1,
      signing_roles:['SIGNER'],
      dissolution_procedure:'Resolve open contracts and asset claims before dissolution.',
      effective_at:'2026-10-01T00:00:00Z',
    },
    roles:[
      {role:'SIGNER',label:'Signer'},
      {role:'MEMBER',label:'Member'},
    ],
    members:[
      {
        member_entity_id:'00000000-0000-4000-8000-000000000101',
        roles:['SIGNER','MEMBER'],
        status:'ACTIVE',
        membership_version:1,
        joined_at:'2026-10-01T00:00:00Z',
      },
    ],
    asset_refs:['kb://assets/org-100'],
    contract_refs:['00000000-0000-4000-8000-000000000102'],
    status:'ACTIVE',
    created_at:'2026-10-01T00:00:00Z',
    updated_at:'2026-10-01T00:00:00Z',
  };
}

test('organization schema accepts the current nh.v3.0 organization contract',()=>{
  const organization=validOrganization();
  assert.equal(validate(organization),true,JSON.stringify(validate.errors));
});

test('organization schema rejects an illegal role',()=>{
  const organization=validOrganization();
  organization.members[0].roles=['SUPERUSER'];
  assert.equal(validate(organization),false);
});

test('organization schema rejects an old schema version',()=>{
  const organization=validOrganization();
  organization.schema_version='nh.v2.0';
  assert.equal(validate(organization),false);
});

test('organization schema rejects a duplicate member record',()=>{
  const organization=validOrganization();
  organization.members.push(structuredClone(organization.members[0]));
  assert.equal(validate(organization),false);
});

test('organization schema has no local wallet balance authority',()=>{
  assert.equal(Object.hasOwn(schema.properties,'wallet_balance'),false);
  assert.equal(Object.hasOwn(schema.properties,'wallet_balance_micro_e'),false);
  assert.equal(Object.hasOwn(schema.properties,'balance_micro_e'),false);

  const organization=validOrganization();
  organization.wallet_balance_micro_e='1000000';
  assert.equal(validate(organization),false);
});
