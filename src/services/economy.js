import { activationDecision, activityEligibility, parseMicroE } from '../domain/energy.js';
import { DAILY_ACTIVITY_FEE_MICRO_E } from '../shared/constants.js';
import { appendEvent } from './core.js';

async function lockWallet(client, worldId, entityId) {
  const wallet = await client.query(
    `SELECT w.world_id, w.entity_id, w.posted_balance_micro_e, w.frozen_micro_e,
            COALESCE((SELECT SUM(r.amount_micro_e) FROM economy.reservations r WHERE r.world_id=w.world_id AND r.entity_id=w.entity_id AND r.status='ACTIVE'),0) AS reserved_micro_e
       FROM economy.wallets w
      WHERE w.world_id=$1 AND w.entity_id=$2
      FOR UPDATE`,
    [worldId, entityId],
  );
  if (wallet.rowCount !== 1) throw Object.assign(new Error('wallet not found'), { code: 'WALLET_NOT_FOUND', status: 404 });
  const row = wallet.rows[0];
  row.available_micro_e = BigInt(row.posted_balance_micro_e) - BigInt(row.frozen_micro_e) - BigInt(row.reserved_micro_e);
  return row;
}

function postingSignature({ accountType, account_type, entityId, entity_id, systemAccount, system_account, amount, amount_micro_e }) {
  return [accountType ?? account_type, entityId ?? entity_id ?? '', systemAccount ?? system_account ?? '', BigInt(amount ?? amount_micro_e).toString()].join('|');
}

async function assertExistingJournalMatches(client, journalId, journalType, postings) {
  const journal = await client.query('SELECT journal_type FROM economy.journals WHERE journal_id=$1', [journalId]);
  const actualPostings = await client.query(`SELECT account_type, entity_id, system_account, amount_micro_e FROM economy.postings WHERE journal_id=$1 ORDER BY posting_id`, [journalId]);
  const expected = postings.map(postingSignature).sort(); const actual = actualPostings.rows.map(postingSignature).sort();
  if (journal.rows[0]?.journal_type !== journalType || expected.length !== actual.length || expected.some((value, index) => value !== actual[index])) {
    throw Object.assign(new Error('ledger business key reused with different journal content'), { code: 'IDEMPOTENCY_CONFLICT', status: 409 });
  }
}

async function createBalancedJournal(client, { worldId, businessKey, journalType, postings }) {
  const journal = await client.query(
    `INSERT INTO economy.journals (world_id, business_key, journal_type, expected_posting_count)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (world_id, business_key) DO NOTHING
     RETURNING journal_id`,
    [worldId, businessKey, journalType, postings.length],
  );
  if (journal.rowCount === 0) {
    const existing = await client.query('SELECT journal_id FROM economy.journals WHERE world_id=$1 AND business_key=$2', [worldId, businessKey]);
    await assertExistingJournalMatches(client, existing.rows[0].journal_id, journalType, postings);
    return { journalId: existing.rows[0].journal_id, replayed: true };
  }
  for (const posting of postings) {
    await client.query(
      `INSERT INTO economy.postings (journal_id, account_type, entity_id, system_account, amount_micro_e) VALUES ($1,$2,$3,$4,$5)`,
      [journal.rows[0].journal_id, posting.accountType, posting.entityId || null, posting.systemAccount || null, posting.amount.toString()],
    );
  }
  return { journalId: journal.rows[0].journal_id, replayed: false };
}

export async function getWallet(client, worldId, entityId) {
  const wallet = await client.query(`SELECT world_id, entity_id, posted_balance_micro_e, frozen_micro_e, reserved_micro_e, available_micro_e FROM economy.wallet_balances WHERE world_id=$1 AND entity_id=$2`, [worldId, entityId]);
  if (wallet.rowCount !== 1) throw Object.assign(new Error('wallet not found'), { code: 'WALLET_NOT_FOUND', status: 404 });
  return wallet.rows[0];
}

export async function mint(client, { worldId, targetEntityId, amountMicroE, basisKey, actorEntityId, actionId }) {
  const amount = parseMicroE(amountMicroE); if (amount <= 0n) throw Object.assign(new Error('mint amount must be positive'), { code: 'INVALID_AMOUNT', status: 400 });
  const actor = await client.query('SELECT entity_type FROM core.entities WHERE world_id=$1 AND entity_id=$2', [worldId, actorEntityId]);
  if (actor.rows[0]?.entity_type !== 'SYSTEM') throw Object.assign(new Error('mint requires SYSTEM actor'), { code: 'FORBIDDEN', status: 403 });
  await lockWallet(client, worldId, targetEntityId);
  const journal = await createBalancedJournal(client, { worldId, businessKey: `mint:${basisKey}`, journalType: 'MINT', postings: [
    { accountType: 'SYSTEM', systemAccount: 'TREASURY_CONTROL', amount: -amount }, { accountType: 'ENTITY_WALLET', entityId: targetEntityId, amount },
  ]});
  if (!journal.replayed) await appendEvent(client, { worldId, aggregateType: 'WALLET', aggregateId: targetEntityId, eventType: 'ENERGY_MINTED', actorEntityId, actionId, payload: { amountMicroE: amount.toString(), basisKey, journalId: journal.journalId } });
  return { journalId: journal.journalId, amountMicroE: amount.toString(), replayed: journal.replayed };
}

export async function transfer(client, { worldId, fromEntityId, toEntityId, amountMicroE, businessKey, actorEntityId, actionId }) {
  const amount = parseMicroE(amountMicroE); if (amount <= 0n || fromEntityId === toEntityId) throw Object.assign(new Error('invalid transfer'), { code: 'INVALID_TRANSFER', status: 400 });
  if (actorEntityId !== fromEntityId) throw Object.assign(new Error('actor cannot spend another wallet without delegation'), { code: 'FORBIDDEN', status: 403 });
  const ids = [fromEntityId, toEntityId].sort(); const locked = new Map(); for (const id of ids) locked.set(id, await lockWallet(client, worldId, id));
  if (locked.get(fromEntityId).available_micro_e < amount) throw Object.assign(new Error('insufficient available Energy'), { code: 'INSUFFICIENT_ENERGY', status: 409 });
  const journal = await createBalancedJournal(client, { worldId, businessKey: `transfer:${businessKey}`, journalType: 'TRANSFER', postings: [
    { accountType: 'ENTITY_WALLET', entityId: fromEntityId, amount: -amount }, { accountType: 'ENTITY_WALLET', entityId: toEntityId, amount },
  ]});
  if (!journal.replayed) {
    await appendEvent(client, { worldId, aggregateType: 'WALLET', aggregateId: fromEntityId, eventType: 'ENERGY_TRANSFERRED_OUT', actorEntityId, actionId, payload: { toEntityId, amountMicroE: amount.toString(), journalId: journal.journalId } });
    await appendEvent(client, { worldId, aggregateType: 'WALLET', aggregateId: toEntityId, eventType: 'ENERGY_TRANSFERRED_IN', actorEntityId, actionId, payload: { fromEntityId, amountMicroE: amount.toString(), journalId: journal.journalId } });
  }
  return { journalId: journal.journalId, amountMicroE: amount.toString(), replayed: journal.replayed };
}

export async function reserve(client, { worldId, entityId, amountMicroE, businessKey, actorEntityId, actionId }) {
  const amount = parseMicroE(amountMicroE); if (amount <= 0n) throw Object.assign(new Error('reservation must be positive'), { code: 'INVALID_AMOUNT', status: 400 });
  if (actorEntityId !== entityId) throw Object.assign(new Error('actor cannot reserve another wallet'), { code: 'FORBIDDEN', status: 403 });
  const wallet = await lockWallet(client, worldId, entityId); if (wallet.available_micro_e < amount) throw Object.assign(new Error('insufficient available Energy'), { code: 'INSUFFICIENT_ENERGY', status: 409 });
  const existing = await client.query('SELECT reservation_id, amount_micro_e, status FROM economy.reservations WHERE world_id=$1 AND entity_id=$2 AND business_key=$3', [worldId, entityId, businessKey]);
  if (existing.rowCount) {
    if (BigInt(existing.rows[0].amount_micro_e) !== amount || existing.rows[0].status !== 'ACTIVE') throw Object.assign(new Error('reservation idempotency conflict'), { code: 'IDEMPOTENCY_CONFLICT', status: 409 });
    return { reservationId: existing.rows[0].reservation_id, amountMicroE: amount.toString(), replayed: true };
  }
  const result = await client.query(`INSERT INTO economy.reservations (world_id, entity_id, business_key, amount_micro_e, status) VALUES ($1,$2,$3,$4,'ACTIVE') RETURNING reservation_id`, [worldId, entityId, businessKey, amount.toString()]);
  await appendEvent(client, { worldId, aggregateType: 'WALLET', aggregateId: entityId, eventType: 'ENERGY_RESERVED', actorEntityId, actionId, payload: { reservationId: result.rows[0].reservation_id, amountMicroE: amount.toString(), businessKey } });
  return { reservationId: result.rows[0].reservation_id, amountMicroE: amount.toString(), replayed: false };
}

export async function releaseReservation(client, { worldId, entityId, reservationId, actorEntityId, actionId }) {
  if (actorEntityId !== entityId) throw Object.assign(new Error('actor cannot release another wallet reservation'), { code: 'FORBIDDEN', status: 403 });
  await lockWallet(client, worldId, entityId);
  const current = await client.query('SELECT status FROM economy.reservations WHERE world_id=$1 AND entity_id=$2 AND reservation_id=$3 FOR UPDATE', [worldId, entityId, reservationId]);
  if (!current.rowCount) throw Object.assign(new Error('reservation not found'), { code: 'RESERVATION_NOT_FOUND', status: 404 });
  if (current.rows[0].status === 'RELEASED') return { reservation_id: reservationId, status: 'RELEASED', replayed: true };
  if (current.rows[0].status !== 'ACTIVE') throw Object.assign(new Error('settled reservation cannot be released'), { code: 'RESERVATION_NOT_RELEASABLE', status: 409 });
  const result = await client.query(`UPDATE economy.reservations SET status='RELEASED', released_at=now() WHERE reservation_id=$1 RETURNING reservation_id, status`, [reservationId]);
  await appendEvent(client, { worldId, aggregateType: 'WALLET', aggregateId: entityId, eventType: 'ENERGY_RESERVATION_RELEASED', actorEntityId, actionId, payload: { reservationId } });
  return { ...result.rows[0], replayed: false };
}

export async function settleReservation(client, { worldId, entityId, reservationId, actualAmountMicroE, businessKey, actorEntityId, actionId }) {
  if (actorEntityId !== entityId) throw Object.assign(new Error('actor cannot settle another wallet reservation'), { code: 'FORBIDDEN', status: 403 });
  const amount = parseMicroE(actualAmountMicroE);
  if (amount < 0n) throw Object.assign(new Error('settlement amount cannot be negative'), { code: 'INVALID_AMOUNT', status: 400 });
  await lockWallet(client, worldId, entityId);
  const current = await client.query(`SELECT amount_micro_e,status,settled_amount_micro_e,settlement_journal_id FROM economy.reservations WHERE world_id=$1 AND entity_id=$2 AND reservation_id=$3 FOR UPDATE`, [worldId,entityId,reservationId]);
  if (!current.rowCount) throw Object.assign(new Error('reservation not found'), { code: 'RESERVATION_NOT_FOUND', status: 404 });
  const row = current.rows[0];
  if (row.status === 'SETTLED') {
    if (BigInt(row.settled_amount_micro_e) !== amount) throw Object.assign(new Error('reservation already settled with a different amount'), { code: 'IDEMPOTENCY_CONFLICT', status: 409 });
    return { reservationId, status: 'SETTLED', amountMicroE: amount.toString(), journalId: row.settlement_journal_id, replayed: true };
  }
  if (row.status !== 'ACTIVE') throw Object.assign(new Error('reservation is not active'), { code: 'RESERVATION_NOT_SETTLEABLE', status: 409 });
  if (amount > BigInt(row.amount_micro_e)) throw Object.assign(new Error('actual charge exceeds reservation'), { code: 'RESERVATION_EXCEEDED', status: 409 });
  let journalId = null;
  if (amount > 0n) {
    const journal = await createBalancedJournal(client, { worldId, businessKey: `resource-charge:${businessKey}`, journalType: 'RESOURCE_CHARGE', postings: [
      { accountType: 'ENTITY_WALLET', entityId, amount: -amount }, { accountType: 'SYSTEM', systemAccount: 'CONSUMPTION_REDEMPTION', amount },
    ]});
    journalId = journal.journalId;
  }
  await client.query(`UPDATE economy.reservations SET status='SETTLED',settled_amount_micro_e=$2,settlement_journal_id=$3,settled_at=now() WHERE reservation_id=$1`, [reservationId,amount.toString(),journalId]);
  await appendEvent(client, { worldId, aggregateType: 'WALLET', aggregateId: entityId, eventType: 'ENERGY_RESERVATION_SETTLED', actorEntityId, actionId, payload: { reservationId, amountMicroE: amount.toString(), journalId } });
  return { reservationId, status: 'SETTLED', amountMicroE: amount.toString(), journalId, replayed: false };
}

async function chargeFee(client, { worldId, entityId, billingDate, actorEntityId, actionId }) {
  const wallet = await lockWallet(client, worldId, entityId);
  const existing = await client.query(`SELECT journal_id, amount_micro_e FROM economy.activity_fees WHERE world_id=$1 AND activity_subject_id=$2 AND billing_date=$3`, [worldId, entityId, billingDate]);
  if (existing.rowCount) return { ...existing.rows[0], replayed: true };
  if (wallet.available_micro_e - DAILY_ACTIVITY_FEE_MICRO_E <= 0n) throw Object.assign(new Error('daily fee would leave no positive available Energy'), { code: 'DAILY_FEE_UNFUNDED', status: 409 });
  const journal = await createBalancedJournal(client, { worldId, businessKey: `daily-fee:${entityId}:${billingDate}`, journalType: 'DAILY_ACTIVITY_FEE', postings: [
    { accountType: 'ENTITY_WALLET', entityId, amount: -DAILY_ACTIVITY_FEE_MICRO_E }, { accountType: 'SYSTEM', systemAccount: 'CONSUMPTION_REDEMPTION', amount: DAILY_ACTIVITY_FEE_MICRO_E },
  ]});
  await client.query(`INSERT INTO economy.activity_fees (world_id, activity_subject_id, billing_date, amount_micro_e, journal_id, rule_version) VALUES ($1,$2,$3,$4,$5,'energy.activity.v3')`, [worldId, entityId, billingDate, DAILY_ACTIVITY_FEE_MICRO_E.toString(), journal.journalId]);
  await appendEvent(client, { worldId, aggregateType: 'WALLET', aggregateId: entityId, eventType: 'DAILY_ACTIVITY_FEE_CHARGED', actorEntityId, actionId, payload: { billingDate, amountMicroE: DAILY_ACTIVITY_FEE_MICRO_E.toString(), journalId: journal.journalId } });
  return { journal_id: journal.journalId, amount_micro_e: DAILY_ACTIVITY_FEE_MICRO_E.toString(), replayed: false };
}

async function assertActivityInitiator(client, worldId, entityId, actorEntityId) {
  if (actorEntityId === entityId) return;
  const actor = await client.query(
    `SELECT entity_type,identity_status FROM core.entities WHERE world_id=$1 AND entity_id=$2`,
    [worldId, actorEntityId],
  );
  if (actor.rows[0]?.entity_type !== 'SYSTEM' || actor.rows[0]?.identity_status !== 'ACTIVE') {
    throw Object.assign(new Error('activity fee/activation may be initiated only by the subject or an active SYSTEM actor'), { code: 'FORBIDDEN', status: 403 });
  }
}

export async function firstActivation(client, { worldId, entityId, billingDate, actorEntityId, actionId }) {
  await assertActivityInitiator(client, worldId, entityId, actorEntityId);
  const prior = await client.query('SELECT first_activated_at FROM economy.activity_subjects WHERE world_id=$1 AND entity_id=$2 FOR UPDATE', [worldId, entityId]);
  if (prior.rows[0]?.first_activated_at) throw Object.assign(new Error('first activation already completed'), { code: 'ALREADY_ACTIVATED', status: 409 });
  const wallet = await lockWallet(client, worldId, entityId); const decision = activationDecision(wallet.available_micro_e);
  if (!decision.allowed) throw Object.assign(new Error(decision.code), { code: decision.code, status: 409 });
  const fee = await chargeFee(client, { worldId, entityId, billingDate, actorEntityId, actionId });
  await client.query(`INSERT INTO economy.activity_subjects (world_id, entity_id, first_activated_at) VALUES ($1,$2,now()) ON CONFLICT (world_id,entity_id) DO UPDATE SET first_activated_at=COALESCE(economy.activity_subjects.first_activated_at,EXCLUDED.first_activated_at)`, [worldId, entityId]);
  const after = await getWallet(client, worldId, entityId); return { fee, wallet: after, eligibility: activityEligibility({ availableMicroE: BigInt(after.available_micro_e), dailyFeePaid: true }) };
}

export async function chargeDailyActivityFee(client, { worldId, entityId, billingDate, actorEntityId, actionId }) {
  await assertActivityInitiator(client, worldId, entityId, actorEntityId);
  const activated = await client.query('SELECT first_activated_at FROM economy.activity_subjects WHERE world_id=$1 AND entity_id=$2', [worldId, entityId]);
  if (!activated.rows[0]?.first_activated_at) throw Object.assign(new Error('subject has never completed first activation'), { code: 'NOT_ACTIVATED', status: 409 });
  const fee = await chargeFee(client, { worldId, entityId, billingDate, actorEntityId, actionId });
  const wallet = await getWallet(client, worldId, entityId); return { fee, wallet, eligibility: activityEligibility({ availableMicroE: BigInt(wallet.available_micro_e), dailyFeePaid: true }) };
}