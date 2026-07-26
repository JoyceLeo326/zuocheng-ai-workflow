import {
  ProductEventValidationError,
  createProductEvent,
  type CreateProductEventInput,
  type ProductEventContext,
} from './product-event.js';
import type {
  AppendProductEventResult,
  ProductEventLedger,
} from './event-ledger.js';

export interface ProductEventRecorder {
  record(input: CreateProductEventInput): Promise<AppendProductEventResult>;
}

export interface CreateProductEventRecorderOptions {
  ledger: ProductEventLedger;
  context: Omit<ProductEventContext, 'now' | 'idFactory'>;
  now?: () => Date;
  idFactory?: () => string;
}

const INPUT_KEYS = ['name', 'idempotencyKey', 'projectId'] as const;

export function createProductEventRecorder({
  ledger,
  context,
  now,
  idFactory,
}: CreateProductEventRecorderOptions): ProductEventRecorder {
  return {
    async record(input) {
      assertInputFields(input);
      const event = createProductEvent(input, {
        ...context,
        ...(now === undefined ? {} : { now }),
        ...(idFactory === undefined ? {} : { idFactory }),
      });
      return ledger.append(event);
    },
  };
}

function assertInputFields(input: CreateProductEventInput): void {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new ProductEventValidationError('input', 'must be an object');
  }
  const allowed = new Set<string>(INPUT_KEYS);
  const extra = Object.keys(input).find((key) => !allowed.has(key));
  if (extra !== undefined) {
    throw new ProductEventValidationError(
      `input.${extra}`,
      'is an unsupported field',
    );
  }
}
