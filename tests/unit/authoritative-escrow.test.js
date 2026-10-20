import test from 'node:test';
import assert from 'node:assert/strict';
import { ECONOMY_PORT_VERSION } from '../../src/ports/economy_port.js';
import { readAuthoritativeEscrowSnapshot } from '../../src/services/authoritative_escrow.js';

function responseFor(request, { escrowRef='escrow:1', balance='15000000', version='12' } = {}) {
  return {
    contract_version:ECONOMY_PORT_VERSION,
    operation:'escrow',
    request_id:request.request_id,
    status:'SUCCEEDED',
    operation_ref:'operation:balance:1',
    resource_version:version,
    result:{
      escrow_action:'BALANCE',escrow_ref:escrowRef,balance_micro_e:balance,
      receipt_ref:'receipt:balance:1',observed_at:'2026-10-20T08:00:00Z',
    },
    error:null,
  };
}

test('authoritative escrow snapshot uses NH-005 BALANCE action and preserves provider receipt/version',async()=>{
  let captured;
  const snapshot=await readAuthoritativeEscrowSnapshot({escrow:async request=>{
    captured=request;
    return responseFor(request);
  }},{principalRef:'kb-principal:employer',contractRef:'contract:1',escrowRef:'escrow:1'});
  assert.equal(captured.contract_version,'nh.kb-economy-port.v2');
  assert.equal(captured.payload.escrow_action,'BALANCE');
  assert.equal(captured.payload.amount_micro_e,undefined);
  assert.equal(snapshot.balanceMicroE,'15000000');
  assert.equal(snapshot.authorityVersion,'12');
  assert.equal(snapshot.receiptRef,'receipt:balance:1');
});

test('snapshot refuses a response for a different escrow and does not fabricate a fallback balance',async()=>{
  await assert.rejects(()=>readAuthoritativeEscrowSnapshot({escrow:async request=>responseFor(request,{escrowRef:'escrow:other'})},{
    principalRef:'kb-principal:employer',contractRef:'contract:1',escrowRef:'escrow:1',
  }),error=>error.code==='KB_ESCROW_SNAPSHOT_MISMATCH');
  await assert.rejects(()=>readAuthoritativeEscrowSnapshot({escrow:async()=>{throw new Error('offline')}},{
    principalRef:'kb-principal:employer',contractRef:'contract:1',escrowRef:'escrow:1',
  }),error=>error.code==='KB_ESCROW_SNAPSHOT_UNAVAILABLE');
});
