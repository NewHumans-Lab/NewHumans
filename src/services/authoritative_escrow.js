import crypto from 'node:crypto';
import {
  ECONOMY_PORT_VERSION,
  assertEconomyPortRequest,
  assertEconomyPortResponse,
} from '../ports/economy_port.js';

function problem(code, message, status = 503) {
  return Object.assign(new Error(message), { code, status });
}
function requiredString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw problem('INVALID_ESCROW_SNAPSHOT_INPUT', field + ' must be a non-empty string', 400);
  }
  return value.trim();
}

/**
 * Read a current, authoritative Knowledge Ball escrow snapshot through NH-005.
 * The returned receipt/version must be copied unchanged into the immutable
 * settlement intent; the KB must atomically compare them during DISTRIBUTE.
 */
export async function readAuthoritativeEscrowSnapshot(economyPort, input) {
  if (!economyPort || typeof economyPort.escrow !== 'function') {
    throw problem('KB_ECONOMY_PORT_UNAVAILABLE', 'authoritative EconomyPort escrow operation is required');
  }
  const principalRef=requiredString(input.principalRef,'principalRef');
  const contractRef=requiredString(input.contractRef,'contractRef');
  const escrowRef=requiredString(input.escrowRef,'escrowRef');
  const requestId=crypto.randomUUID();
  const request={
    contract_version:ECONOMY_PORT_VERSION,
    operation:'escrow',
    request_id:requestId,
    idempotency_key:'escrow-balance-read:'+requestId,
    principal_ref:principalRef,
    payload:{escrow_action:'BALANCE',contract_ref:contractRef,escrow_ref:escrowRef},
  };
  assertEconomyPortRequest('escrow',request);
  let response;
  try {
    response=await economyPort.escrow(request);
    assertEconomyPortResponse('escrow',response);
  } catch (error) {
    throw problem('KB_ESCROW_SNAPSHOT_UNAVAILABLE', 'Knowledge Ball did not provide a valid authoritative escrow snapshot', 503);
  }
  if (!['SUCCEEDED','DUPLICATE'].includes(response.status)) {
    throw problem('KB_ESCROW_SNAPSHOT_UNAVAILABLE', 'Knowledge Ball escrow balance is not authoritative and available', 503);
  }
  const result=response.result;
  if (result.escrow_action !== 'BALANCE' || result.escrow_ref !== escrowRef) {
    throw problem('KB_ESCROW_SNAPSHOT_MISMATCH', 'Knowledge Ball returned a snapshot for a different escrow', 502);
  }
  return {
    escrowRef:result.escrow_ref,
    balanceMicroE:result.balance_micro_e,
    authorityVersion:response.resource_version,
    receiptRef:result.receipt_ref,
    observedAt:new Date(result.observed_at).toISOString(),
  };
}
