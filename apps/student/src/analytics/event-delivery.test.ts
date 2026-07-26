import { describe, expect, it, vi } from 'vitest';
import { MemoryProductEventLedger } from './event-ledger.js';
import { createProductEventRecorder } from './event-recorder.js';
import {
  AnalyticsDeliveryError,
  sendPendingProductEvents,
} from './event-delivery.js';

async function pendingLedger() {
  const ledger = new MemoryProductEventLedger();
  const recorder = createProductEventRecorder({
    ledger,
    context: {
      anonymousId: '019b0000-0000-7000-8000-000000000020',
      sourceVersion: 'student-1.0.0',
    },
    now: () => new Date('2026-07-27T04:10:00.000Z'),
    idFactory: () => '019b0000-0000-7000-8000-000000000021',
  });
  await recorder.record({
    name: 'signup_completed',
    idempotencyKey: 'signup_completed:user-001',
  });
  return ledger;
}

describe('optional product event delivery', () => {
  it('does not make a request or claim delivery when no endpoint is configured', async () => {
    const ledger = await pendingLedger();
    const fetcher = vi.fn();

    await expect(
      sendPendingProductEvents({
        ledger,
        endpoint: null,
        fetcher,
      }),
    ).resolves.toEqual({ status: 'not_configured', sent: 0 });
    expect(fetcher).not.toHaveBeenCalled();
    await expect(ledger.pending(10)).resolves.toHaveLength(1);
  });

  it('marks a batch delivered only after a successful HTTP response', async () => {
    const ledger = await pendingLedger();
    const fetcher = vi.fn(async () => new Response(null, { status: 202 }));

    await expect(
      sendPendingProductEvents({
        ledger,
        endpoint: 'https://events.example.test/v1/batches',
        fetcher,
        now: () => new Date('2026-07-27T04:11:00.000Z'),
      }),
    ).resolves.toEqual({ status: 'sent', sent: 1 });
    expect(fetcher).toHaveBeenCalledWith(
      'https://events.example.test/v1/batches',
      expect.objectContaining({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      }),
    );
    await expect(ledger.pending(10)).resolves.toEqual([]);
  });

  it('keeps failed requests pending and reports a bounded failure code', async () => {
    const ledger = await pendingLedger();
    const fetcher = vi.fn(async () => new Response(null, { status: 503 }));

    await expect(
      sendPendingProductEvents({
        ledger,
        endpoint: 'https://events.example.test/v1/batches',
        fetcher,
        now: () => new Date('2026-07-27T04:12:00.000Z'),
      }),
    ).rejects.toMatchObject({
      name: 'AnalyticsDeliveryError',
      code: 'HTTP_ERROR',
    });
    expect(
      (await ledger.pending(10))[0]!.delivery,
    ).toMatchObject({
      state: 'pending',
      attemptCount: 1,
      lastFailureCode: 'HTTP_ERROR',
    });
  });

  it('rejects unsafe endpoints before reading or sending the outbox', async () => {
    const ledger = await pendingLedger();
    const fetcher = vi.fn();
    await expect(
      sendPendingProductEvents({
        ledger,
        endpoint: 'http://events.example.test?api_key=secret',
        fetcher,
      }),
    ).rejects.toBeInstanceOf(AnalyticsDeliveryError);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
