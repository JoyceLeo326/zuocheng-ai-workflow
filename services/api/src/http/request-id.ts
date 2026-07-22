import { randomFillSync } from 'node:crypto';

type Clock = () => Date;
type RandomFill = (target: Uint8Array) => Uint8Array;

const MAX_UUID_V7_TIMESTAMP = 0xffffffffffff;

export function createUuidV7(
  clock: Clock = () => new Date(),
  randomFill: RandomFill = (target) => randomFillSync(target),
): string {
  const timestamp = clock().getTime();
  if (
    !Number.isSafeInteger(timestamp) ||
    timestamp < 0 ||
    timestamp > MAX_UUID_V7_TIMESTAMP
  ) {
    throw new TypeError('UUIDv7 requires a valid 48-bit Unix timestamp');
  }

  const bytes = randomFill(new Uint8Array(16));
  if (bytes.byteLength !== 16) {
    throw new TypeError('UUIDv7 random source must fill exactly 16 bytes');
  }

  let remainingTimestamp = timestamp;
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = remainingTimestamp % 256;
    remainingTimestamp = Math.floor(remainingTimestamp / 256);
  }

  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;

  const hex = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
