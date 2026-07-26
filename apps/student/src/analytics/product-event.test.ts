import { describe, expect, it } from 'vitest';
import {
  PRODUCT_EVENT_NAMES,
  ProductEventValidationError,
  createProductEvent,
  parseProductEvent,
  resolveAnonymousBrowserId,
} from './product-event.js';

const EVENT_ID = '019b0000-0000-7000-8000-000000000001';
const ANONYMOUS_ID = '019b0000-0000-7000-8000-000000000002';
const OCCURRED_AT = '2026-07-27T04:00:00.000Z';

describe('product event schema', () => {
  it('accepts exactly the ten supported successful-action names', () => {
    expect(PRODUCT_EVENT_NAMES).toEqual([
      'signup_completed',
      'project_created',
      'file_uploaded',
      'task_defined',
      'evidence_added',
      'outline_created',
      'artifact_generated',
      'artifact_exported',
      'course_completed',
      'second_project_started',
    ]);
  });

  it('creates a stable, versioned and privacy-minimal event', () => {
    const event = createProductEvent(
      {
        name: 'project_created',
        idempotencyKey: 'project_created:project-001:1',
        projectId: 'project-001',
      },
      {
        anonymousId: ANONYMOUS_ID,
        userId: 'user-001',
        workspaceId: 'workspace-001',
        sourceVersion: 'student-1.0.0',
        now: () => new Date(OCCURRED_AT),
        idFactory: () => EVENT_ID,
      },
    );

    expect(event).toEqual({
      schemaVersion: 1,
      id: EVENT_ID,
      name: 'project_created',
      occurredAt: OCCURRED_AT,
      anonymousId: ANONYMOUS_ID,
      userId: 'user-001',
      workspaceId: 'workspace-001',
      projectId: 'project-001',
      idempotencyKey: 'project_created:project-001:1',
      sourceVersion: 'student-1.0.0',
    });
    expect(parseProductEvent(event)).toEqual(event);
  });

  it('rejects unsupported names, extra payload fields and identity-shaped personal data', () => {
    const base = {
      schemaVersion: 1,
      id: EVENT_ID,
      name: 'project_created',
      occurredAt: OCCURRED_AT,
      anonymousId: ANONYMOUS_ID,
      userId: null,
      workspaceId: null,
      projectId: 'project-001',
      idempotencyKey: 'project_created:project-001:1',
      sourceVersion: 'student-1.0.0',
    };

    expect(() =>
      parseProductEvent({ ...base, name: 'page_viewed' }),
    ).toThrow(ProductEventValidationError);
    expect(() =>
      parseProductEvent({ ...base, taskBody: 'private task body' }),
    ).toThrow(ProductEventValidationError);
    expect(() =>
      parseProductEvent({ ...base, userId: 'person@example.com' }),
    ).toThrow(ProductEventValidationError);
  });

  it('keeps one anonymous browser identity in supplied storage', () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
    };

    expect(
      resolveAnonymousBrowserId({
        storage,
        idFactory: () => ANONYMOUS_ID,
      }),
    ).toBe(ANONYMOUS_ID);
    expect(
      resolveAnonymousBrowserId({
        storage,
        idFactory: () => {
          throw new Error('must reuse stored identity');
        },
      }),
    ).toBe(ANONYMOUS_ID);
  });
});
