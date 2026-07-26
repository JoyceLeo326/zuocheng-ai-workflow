export * from './schema.js';

export const DATABASE_FOUNDATION_STATUS = Object.freeze({
  dialect: 'postgresql',
  migrationVersion: '0000_foundation',
  ready: false,
  reason: 'runtime-database-probe-required',
} as const);
