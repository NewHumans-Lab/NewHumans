import {
  DAILY_ACTIVITY_FEE_MICRO_E,
  FIRST_ACTIVATION_MIN_MICRO_E,
  TASK_SEEK_MIN_MICRO_E,
} from '../shared/constants.js';

export function parseMicroE(value) {
  if (typeof value === 'bigint') return value;
  if (typeof value !== 'string' || !/^-?\d+$/.test(value)) {
    throw new TypeError('microE amounts must be decimal integer strings');
  }
  return BigInt(value);
}

export function availableEnergy({ posted, reserved = 0n, frozen = 0n }) {
  return BigInt(posted) - BigInt(reserved) - BigInt(frozen);
}

export function activationDecision(availableMicroE) {
  const available = BigInt(availableMicroE);
  if (available < FIRST_ACTIVATION_MIN_MICRO_E) {
    return { allowed: false, code: 'FIRST_ACTIVATION_MINIMUM_UNFUNDED' };
  }
  const afterFee = available - DAILY_ACTIVITY_FEE_MICRO_E;
  if (afterFee <= 0n) {
    return { allowed: false, code: 'DAILY_FEE_UNFUNDED' };
  }
  return {
    allowed: true,
    feeMicroE: DAILY_ACTIVITY_FEE_MICRO_E,
    afterFeeMicroE: afterFee,
    canSeekTasks: afterFee >= TASK_SEEK_MIN_MICRO_E,
  };
}

export function activityEligibility({ availableMicroE, dailyFeePaid }) {
  const available = BigInt(availableMicroE);
  if (available <= 0n) return { canAct: false, canSeekTasks: false, code: 'NO_AVAILABLE_ENERGY' };
  if (!dailyFeePaid) return { canAct: false, canSeekTasks: false, code: 'DAILY_FEE_REQUIRED' };
  return {
    canAct: true,
    canSeekTasks: available >= TASK_SEEK_MIN_MICRO_E,
    code: available >= TASK_SEEK_MIN_MICRO_E ? 'ACTIVE_CAN_SEEK' : 'ACTIVE_INBOUND_ONLY',
  };
}
