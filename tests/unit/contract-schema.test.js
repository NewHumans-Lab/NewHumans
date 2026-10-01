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

const validateContract=compile('contract.schema.json');
const validateVersion=compile('contract-version.schema.json');
const validateAcceptance=compile('contract-acceptance.schema.json');
const validateDelivery=compile('contract-delivery.schema.json');
const validateDispute=compile('contract-dispute.schema.json');

const ids={
  contract:'00000000-0000-4000-8000-000000000001',
  employer:'00000000-0000-4000-8000-000000000002',
  contractor:'00000000-0000-4000-8000-000000000003',
  acceptance:'00000000-0000-4000-8000-000000000004',
  delivery:'00000000-0000-4000-8000-000000000005',
  dispute:'00000000-0000-4000-8000-000000000006',
};
const digest='a'.repeat(64);

const contract={
  schema_version:'nh.v3.0',
  contract_id:ids.contract,
  world_id:'world-1',
  employer_entity_id:ids.employer,
  contractor_entity_id:ids.contractor,
  current_version:1,
  status:'ACTIVE',
  kb_escrow_ref:'kb://economy/escrows/escrow-1',
  kb_prepayment_ref:null,
  kb_settlement_ref:null,
  created_at:'2026-10-01T06:00:00Z',
  updated_at:'2026-10-01T06:01:00Z',
};

const version={
  schema_version:'nh.v3.0',
  contract_id:ids.contract,
  version:1,
  employer_entity_id:ids.employer,
  contractor_entity_id:ids.contractor,
  scope:'Implement the agreed M04 slice.',
  deliverables:[{deliverable_id:'d1',description:'Working implementation and tests.'}],
  acceptance_criteria:[{criterion_id:'a1',description:'All task tests pass.',evidence_required:true}],
  price_micro_e:'250000000',
  prepayment_micro_e:'0',
  inference_budget_micro_e:'1000000',
  start_condition:'Both parties accept this exact version and KB escrow succeeds.',
  delivery_deadline:'2026-10-08T06:00:00Z',
  acceptance_deadline:'2026-10-10T06:00:00Z',
  rework_limit:2,
  cancellation_terms:'Cancellation follows accepted version terms.',
  dispute_procedure:'Open an M04 dispute with evidence and version binding.',
  auto_acceptance:{enabled:false,timeout_action:'ESCALATE'},
  inference_cost_payer:'EMPLOYER',
  rules_version:'m04.contract.v1',
  terms_digest:digest,
  created_at:'2026-10-01T06:00:00Z',
};

const acceptance={
  schema_version:'nh.v3.0',
  acceptance_id:ids.acceptance,
  contract_id:ids.contract,
  contract_version:1,
  party_entity_id:ids.employer,
  party_role:'EMPLOYER',
  terms_digest:digest,
  accepted_at:'2026-10-01T06:00:30Z',
  idempotency_key:'accept-employer-v1',
};

const delivery={
  schema_version:'nh.v3.0',
  delivery_id:ids.delivery,
  contract_id:ids.contract,
  contract_version:1,
  submitted_by_entity_id:ids.contractor,
  attempt:1,
  artifact_refs:['object-version-1'],
  status:'SUBMITTED',
  submitted_at:'2026-10-07T06:00:00Z',
  reviewed_at:null,
  reviewed_by_entity_id:null,
  rejection_criterion_ids:[],
  idempotency_key:'delivery-v1-a1',
};

const dispute={
  schema_version:'nh.v3.0',
  dispute_id:ids.dispute,
  contract_id:ids.contract,
  contract_version:1,
  opened_by_entity_id:ids.contractor,
  reason:'Acceptance criterion a1 was rejected without matching evidence.',
  evidence_refs:['object-version-1','review-1'],
  status:'OPEN',
  resolution:null,
  kb_settlement_ref:null,
  opened_at:'2026-10-08T06:00:00Z',
  updated_at:'2026-10-08T06:00:00Z',
};

test('contract schemas accept version-bound contract lifecycle records',()=>{
  for(const [name,validate,value] of [
    ['contract',validateContract,contract],
    ['version',validateVersion,version],
    ['acceptance',validateAcceptance,acceptance],
    ['delivery',validateDelivery,delivery],
    ['dispute',validateDispute,dispute],
  ]){
    assert.equal(validate(value),true,`${name}: ${JSON.stringify(validate.errors)}`);
  }
});

test('contract version requires both delivery and acceptance deadlines',()=>{
  for(const field of ['delivery_deadline','acceptance_deadline']){
    const candidate={...version};
    delete candidate[field];
    assert.equal(validateVersion(candidate),false,`${field} must be explicit`);
  }
});

test('contract version requires non-empty acceptance criteria',()=>{
  const missing={...version};
  delete missing.acceptance_criteria;
  assert.equal(validateVersion(missing),false,'missing acceptance criteria must fail');
  assert.equal(validateVersion({...version,acceptance_criteria:[]}),false,'empty acceptance criteria must fail');
});

test('microE amounts must be decimal integer strings',()=>{
  for(const price_micro_e of [250000000,'250000000.0','-1','1e6']){
    assert.equal(validateVersion({...version,price_micro_e}),false,`${price_micro_e} must fail`);
  }
  assert.equal(validateVersion({...version,price_micro_e:'0'}),true,JSON.stringify(validateVersion.errors));
});

test('schema and record versions reject invalid versions',()=>{
  assert.equal(validateVersion({...version,schema_version:'nh.v2.0'}),false,'wrong schema version must fail');
  assert.equal(validateVersion({...version,version:0}),false,'contract version zero must fail');
  assert.equal(validateAcceptance({...acceptance,contract_version:0}),false,'acceptance must bind a positive contract version');
  assert.equal(validateDelivery({...delivery,contract_version:0}),false,'delivery must bind a positive contract version');
  assert.equal(validateDispute({...dispute,contract_version:0}),false,'dispute must bind a positive contract version');
});

test('active and settled contracts require Knowledge Ball economic references',()=>{
  assert.equal(validateContract({...contract,kb_escrow_ref:null}),false,'ACTIVE requires kb_escrow_ref');
  assert.equal(validateContract({...contract,status:'SETTLED',kb_settlement_ref:null}),false,'SETTLED requires kb_settlement_ref');
  assert.equal(validateContract({...contract,status:'SETTLED',kb_settlement_ref:'kb://economy/settlements/settlement-1'}),true,JSON.stringify(validateContract.errors));
  assert.equal(validateContract({...contract,status:'PROPOSED',kb_escrow_ref:null}),true,JSON.stringify(validateContract.errors));
});

test('resolved disputes retain external KB settlement evidence',()=>{
  assert.equal(validateDispute({...dispute,status:'RESOLVED',resolution:'Split escrow per adjudication.'}),false,'resolved dispute without KB settlement ref must fail');
  assert.equal(validateDispute({...dispute,status:'RESOLVED',resolution:'Split escrow per adjudication.',kb_settlement_ref:'kb://economy/settlements/settlement-2'}),true,JSON.stringify(validateDispute.errors));
});
