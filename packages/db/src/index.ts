export type DatabaseReadiness =
  | { ready: true; migrationVersion: string }
  | { ready: false; reason: 'not-configured-until-zc-02' };

export const DATABASE_FOUNDATION_STATUS: DatabaseReadiness = Object.freeze({
  ready: false,
  reason: 'not-configured-until-zc-02',
});

