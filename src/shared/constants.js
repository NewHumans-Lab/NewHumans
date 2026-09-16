export const SCHEMA_VERSION = 'nh.v3.0';
export const MICRO_E_PER_E = 1_000_000n;
export const FIRST_ACTIVATION_MIN_MICRO_E = 100n * MICRO_E_PER_E;
export const DAILY_ACTIVITY_FEE_MICRO_E = 1n * MICRO_E_PER_E;
export const TASK_SEEK_MIN_MICRO_E = 100n * MICRO_E_PER_E;

export const ENTITY_TYPES = Object.freeze(['HUMAN', 'AGENT', 'COMPANY', 'ORGANIZATION', 'SYSTEM']);
export const ACTION_STATUS = Object.freeze(['PENDING', 'SUCCEEDED', 'FAILED']);
export const RESERVATION_STATUS = Object.freeze(['ACTIVE', 'SETTLED', 'RELEASED']);
