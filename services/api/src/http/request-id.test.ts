import { UUIDv7Schema } from '@zuocheng/contracts';
import { describe, expect, it } from 'vitest';
import { createUuidV7 } from './request-id.js';

describe('server request IDs', () => {
  it('creates a UUIDv7 using the supplied clock and secure-byte boundary', () => {
    const id = createUuidV7(
      () => new Date('2026-07-23T09:30:00.000Z'),
      (target) => target.fill(0xab),
    );

    expect(UUIDv7Schema.parse(id)).toBe(id);
    expect(id.slice(0, 13)).toBe('019f8e4f-75c0');
    expect(id[14]).toBe('7');
    expect(['8', '9', 'a', 'b']).toContain(id[19]);
  });
});
