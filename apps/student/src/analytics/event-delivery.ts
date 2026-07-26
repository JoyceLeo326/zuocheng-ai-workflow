import type {
  ProductEventDeliveryFailureCode,
  ProductEventLedger,
} from './event-ledger.js';

export type ProductEventDeliveryResult =
  | Readonly<{ status: 'not_configured'; sent: 0 }>
  | Readonly<{ status: 'idle'; sent: 0 }>
  | Readonly<{ status: 'sent'; sent: number }>;

export type AnalyticsDeliveryErrorCode =
  | 'INVALID_ENDPOINT'
  | 'NETWORK'
  | 'HTTP_ERROR'
  | 'ABORTED'
  | 'LEDGER_ERROR';

export class AnalyticsDeliveryError extends Error {
  constructor(readonly code: AnalyticsDeliveryErrorCode) {
    super(`Product event delivery failed: ${code}`);
    this.name = 'AnalyticsDeliveryError';
  }
}

export interface SendPendingProductEventsOptions {
  ledger: ProductEventLedger;
  endpoint: string | null;
  fetcher?: typeof fetch;
  batchSize?: number;
  now?: () => Date;
  signal?: AbortSignal;
}

export async function sendPendingProductEvents({
  ledger,
  endpoint,
  fetcher = globalThis.fetch,
  batchSize = 100,
  now = () => new Date(),
  signal,
}: SendPendingProductEventsOptions): Promise<ProductEventDeliveryResult> {
  const normalizedEndpoint = normalizeEndpoint(endpoint);
  if (normalizedEndpoint === null) {
    return { status: 'not_configured', sent: 0 };
  }
  if (fetcher === undefined) {
    throw new AnalyticsDeliveryError('NETWORK');
  }
  const pending = await ledger.pending(batchSize);
  if (pending.length === 0) {
    return { status: 'idle', sent: 0 };
  }
  const eventIds = pending.map((record) => record.event.id);
  let response: Response;
  try {
    const request: RequestInit = {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        format: 'zuocheng-product-event-batch',
        schemaVersion: 1,
        events: pending.map((record) => record.event),
      }),
      ...(signal === undefined ? {} : { signal }),
    };
    response = await fetcher(normalizedEndpoint, request);
  } catch {
    const code: ProductEventDeliveryFailureCode =
      signal?.aborted === true ? 'ABORTED' : 'NETWORK';
    await ledger.markFailed(eventIds, code, canonicalNow(now));
    throw new AnalyticsDeliveryError(code);
  }
  if (!response.ok) {
    await ledger.markFailed(eventIds, 'HTTP_ERROR', canonicalNow(now));
    throw new AnalyticsDeliveryError('HTTP_ERROR');
  }
  try {
    await ledger.markDelivered(eventIds, canonicalNow(now));
  } catch {
    throw new AnalyticsDeliveryError('LEDGER_ERROR');
  }
  return { status: 'sent', sent: pending.length };
}

export function normalizeProductEventEndpoint(
  endpoint: string,
): string {
  const normalized = normalizeEndpoint(endpoint);
  if (normalized === null) {
    throw new AnalyticsDeliveryError('INVALID_ENDPOINT');
  }
  return normalized;
}

function normalizeEndpoint(endpoint: string | null): string | null {
  const candidate = endpoint?.trim() ?? '';
  if (candidate.length === 0) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new AnalyticsDeliveryError('INVALID_ENDPOINT');
  }
  if (
    url.protocol !== 'https:' ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw new AnalyticsDeliveryError('INVALID_ENDPOINT');
  }
  return url.toString();
}

function canonicalNow(now: () => Date): string {
  const value = now();
  if (!Number.isFinite(value.valueOf())) {
    throw new AnalyticsDeliveryError('LEDGER_ERROR');
  }
  return value.toISOString();
}
