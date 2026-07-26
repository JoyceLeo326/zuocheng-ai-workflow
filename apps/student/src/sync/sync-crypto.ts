import {
  ENCRYPTED_SYNC_FORMAT,
  ENCRYPTED_SYNC_FORMAT_VERSION,
  SyncError,
  parseEncryptedSyncBundle,
  type DecryptedSyncPackage,
  type EncryptedSyncBundle,
  type EncryptedSyncDescriptor,
  type LocalSyncSnapshot,
} from './sync-domain.js';

export const SYNC_PBKDF2_ITERATIONS = 310_000;

const MAX_PACKAGE_BYTES = 64 * 1024 * 1024;
const CIPHERTEXT_CHUNK_CHARACTERS = 700_000;
const MIN_PASSPHRASE_CHARACTERS = 12;

interface PlainSyncPayload {
  format: 'zuocheng-sync-payload';
  formatVersion: 1;
  projectId: string;
  projectTitle: string;
  projectVersion: number;
  projectUpdatedAt: string;
  packageMediaType: string;
  packageSha256: string;
  packageBase64Url: string;
}

export async function encryptProjectPackage(
  input: LocalSyncSnapshot,
  passphrase: string,
  cryptoProvider: Crypto | undefined = globalThis.crypto,
  encryptedAt = new Date().toISOString(),
): Promise<EncryptedSyncBundle> {
  const crypto = requireCrypto(cryptoProvider);
  validateSnapshot(input);
  const validPassphrase = passphraseAt(passphrase);
  if (input.package.size > MAX_PACKAGE_BYTES) {
    throw new SyncError(
      'PAYLOAD_TOO_LARGE',
      '项目包超过当前同步上限，请移除不需要的材料后重试。',
    );
  }
  const packageBytes = new Uint8Array(await input.package.arrayBuffer());
  const packageSha256 = await sha256(packageBytes, crypto.subtle);
  const salt = randomBytes(crypto, 16);
  const iv = randomBytes(crypto, 12);
  const revision = base64UrlEncode(randomBytes(crypto, 18));
  const payload: PlainSyncPayload = {
    format: 'zuocheng-sync-payload',
    formatVersion: 1,
    projectId: input.projectId,
    projectTitle: input.projectTitle,
    projectVersion: input.projectVersion,
    projectUpdatedAt: input.projectUpdatedAt,
    packageMediaType: input.package.type || 'application/zip',
    packageSha256,
    packageBase64Url: base64UrlEncode(packageBytes),
  };
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const key = await deriveKey(
    validPassphrase,
    salt,
    SYNC_PBKDF2_ITERATIONS,
    crypto.subtle,
  );
  const additionalData = additionalDataFor({
    revision,
    projectId: input.projectId,
    projectVersion: input.projectVersion,
    projectUpdatedAt: input.projectUpdatedAt,
  });
  const encrypted = new Uint8Array(
    await crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: ownedBuffer(iv),
        additionalData: ownedBuffer(additionalData),
        tagLength: 128,
      },
      key,
      ownedBuffer(plaintext),
    ),
  );
  const encoded = base64UrlEncode(encrypted);
  const encryptedFiles: Record<string, string> = {};
  const chunkPaths: string[] = [];
  let chunkIndex = 0;
  for (
    let offset = 0;
    offset < encoded.length;
    offset += CIPHERTEXT_CHUNK_CHARACTERS
  ) {
    chunkIndex += 1;
    const path = `payload-${String(chunkIndex).padStart(4, '0')}.txt`;
    chunkPaths.push(path);
    encryptedFiles[path] = encoded.slice(
      offset,
      offset + CIPHERTEXT_CHUNK_CHARACTERS,
    );
  }
  const descriptor: EncryptedSyncDescriptor = {
    format: ENCRYPTED_SYNC_FORMAT,
    formatVersion: ENCRYPTED_SYNC_FORMAT_VERSION,
    revision,
    projectId: input.projectId,
    projectVersion: input.projectVersion,
    projectUpdatedAt: input.projectUpdatedAt,
    encryptedAt: canonicalDate(encryptedAt, 'encryptedAt'),
    algorithm: {
      name: 'AES-GCM',
      kdf: 'PBKDF2',
      hash: 'SHA-256',
      iterations: SYNC_PBKDF2_ITERATIONS,
      salt: base64UrlEncode(salt),
      iv: base64UrlEncode(iv),
    },
    payload: {
      encoding: 'base64url',
      chunkPaths,
      ciphertextBytes: encrypted.byteLength,
      ciphertextSha256: await sha256(encrypted, crypto.subtle),
    },
  };
  return parseEncryptedSyncBundle({ descriptor, encryptedFiles });
}

export async function decryptProjectPackage(
  input: EncryptedSyncBundle,
  passphrase: string,
  cryptoProvider: Crypto | undefined = globalThis.crypto,
): Promise<DecryptedSyncPackage> {
  const crypto = requireCrypto(cryptoProvider);
  const bundle = parseEncryptedSyncBundle(input);
  const validPassphrase = passphraseAt(passphrase);
  let ciphertext: Uint8Array;
  try {
    ciphertext = base64UrlDecode(
      bundle.descriptor.payload.chunkPaths
        .map((path) => bundle.encryptedFiles[path])
        .join(''),
    );
  } catch (error) {
    throw new SyncError(
      'CORRUPT_PAYLOAD',
      '远端加密内容已损坏，未导入任何项目。',
      { cause: error },
    );
  }
  if (
    ciphertext.byteLength !==
      bundle.descriptor.payload.ciphertextBytes ||
    (await sha256(ciphertext, crypto.subtle)) !==
      bundle.descriptor.payload.ciphertextSha256
  ) {
    throw new SyncError(
      'CORRUPT_PAYLOAD',
      '远端加密内容校验失败，未导入任何项目。',
    );
  }
  const salt = base64UrlDecode(bundle.descriptor.algorithm.salt);
  const iv = base64UrlDecode(bundle.descriptor.algorithm.iv);
  const key = await deriveKey(
    validPassphrase,
    salt,
    bundle.descriptor.algorithm.iterations,
    crypto.subtle,
  );
  const additionalData = additionalDataFor(bundle.descriptor);
  let plaintext: ArrayBuffer;
  try {
    plaintext = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: ownedBuffer(iv),
        additionalData: ownedBuffer(additionalData),
        tagLength: 128,
      },
      key,
      ownedBuffer(ciphertext),
    );
  } catch (error) {
    throw new SyncError(
      'INVALID_PASSPHRASE',
      '同步口令不正确，或远端内容无法解密。',
      { cause: error },
    );
  }
  let payload: PlainSyncPayload;
  try {
    payload = parsePlainPayload(
      JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(plaintext),
      ),
    );
  } catch (error) {
    throw new SyncError(
      'CORRUPT_PAYLOAD',
      '解密后的项目内容无效，未导入任何项目。',
      { cause: error },
    );
  }
  if (
    payload.projectId !== bundle.descriptor.projectId ||
    payload.projectVersion !== bundle.descriptor.projectVersion ||
    payload.projectUpdatedAt !== bundle.descriptor.projectUpdatedAt
  ) {
    throw new SyncError(
      'CORRUPT_PAYLOAD',
      '加密内容与远端索引不一致，未导入任何项目。',
    );
  }
  let packageBytes: Uint8Array;
  try {
    packageBytes = base64UrlDecode(payload.packageBase64Url);
  } catch (error) {
    throw new SyncError(
      'CORRUPT_PAYLOAD',
      '项目包编码无效，未导入任何项目。',
      { cause: error },
    );
  }
  if (
    packageBytes.byteLength > MAX_PACKAGE_BYTES ||
    (await sha256(packageBytes, crypto.subtle)) !== payload.packageSha256
  ) {
    throw new SyncError(
      'CORRUPT_PAYLOAD',
      '项目包内容校验失败，未导入任何项目。',
    );
  }
  return {
    projectId: payload.projectId,
    projectTitle: payload.projectTitle,
    projectVersion: payload.projectVersion,
    projectUpdatedAt: payload.projectUpdatedAt,
    package: bytesToBlob(packageBytes, payload.packageMediaType),
    packageSha256: payload.packageSha256,
  };
}

export async function sha256Blob(
  blob: Blob,
  cryptoProvider: Crypto | undefined = globalThis.crypto,
): Promise<string> {
  const crypto = requireCrypto(cryptoProvider);
  return sha256(
    new Uint8Array(await blob.arrayBuffer()),
    crypto.subtle,
  );
}

function validateSnapshot(input: LocalSyncSnapshot): void {
  if (
    typeof input !== 'object' ||
    input === null ||
    typeof input.projectId !== 'string' ||
    input.projectId.length === 0 ||
    input.projectId.length > 256 ||
    typeof input.projectTitle !== 'string' ||
    input.projectTitle.length === 0 ||
    input.projectTitle.length > 500 ||
    !Number.isSafeInteger(input.projectVersion) ||
    input.projectVersion < 1 ||
    !(input.package instanceof Blob)
  ) {
    throw new SyncError('INVALID_INPUT', '项目包信息不完整。');
  }
  canonicalDate(input.projectUpdatedAt, 'projectUpdatedAt');
}

function parsePlainPayload(input: unknown): PlainSyncPayload {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('payload must be an object');
  }
  const object = input as Record<string, unknown>;
  const projectVersion = object.projectVersion;
  if (
    object.format !== 'zuocheng-sync-payload' ||
    object.formatVersion !== 1 ||
    typeof object.projectId !== 'string' ||
    object.projectId.length === 0 ||
    object.projectId.length > 256 ||
    typeof object.projectTitle !== 'string' ||
    object.projectTitle.length === 0 ||
    object.projectTitle.length > 500 ||
    typeof projectVersion !== 'number' ||
    !Number.isSafeInteger(projectVersion) ||
    projectVersion < 1 ||
    typeof object.projectUpdatedAt !== 'string' ||
    typeof object.packageMediaType !== 'string' ||
    object.packageMediaType.length === 0 ||
    object.packageMediaType.length > 200 ||
    typeof object.packageSha256 !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(object.packageSha256) ||
    typeof object.packageBase64Url !== 'string' ||
    !/^[a-zA-Z0-9_-]*$/u.test(object.packageBase64Url)
  ) {
    throw new Error('payload fields are invalid');
  }
  return {
    format: 'zuocheng-sync-payload',
    formatVersion: 1,
    projectId: object.projectId,
    projectTitle: object.projectTitle,
    projectVersion,
    projectUpdatedAt: canonicalDate(
      object.projectUpdatedAt,
      'projectUpdatedAt',
    ),
    packageMediaType: object.packageMediaType,
    packageSha256: object.packageSha256,
    packageBase64Url: object.packageBase64Url,
  };
}

function requireCrypto(cryptoProvider: Crypto | undefined): Crypto {
  if (
    cryptoProvider?.subtle === undefined ||
    typeof cryptoProvider.getRandomValues !== 'function'
  ) {
    throw new SyncError(
      'CRYPTO_UNAVAILABLE',
      '当前浏览器无法加密同步内容。',
    );
  }
  return cryptoProvider;
}

function passphraseAt(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length < MIN_PASSPHRASE_CHARACTERS ||
    value.length > 1_024 ||
    value !== value.trim()
  ) {
    throw new SyncError(
      'INVALID_PASSPHRASE',
      '同步口令至少需要 12 个字符，且首尾不能有空格。',
    );
  }
  return value;
}

async function deriveKey(
  passphrase: string,
  salt: Uint8Array,
  iterations: number,
  subtle: SubtleCrypto,
): Promise<CryptoKey> {
  const material = await subtle.importKey(
    'raw',
    ownedBuffer(new TextEncoder().encode(passphrase)),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: ownedBuffer(salt),
      iterations,
      hash: 'SHA-256',
    },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

function additionalDataFor(input: {
  revision: string;
  projectId: string;
  projectVersion: number;
  projectUpdatedAt: string;
}): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      format: ENCRYPTED_SYNC_FORMAT,
      formatVersion: ENCRYPTED_SYNC_FORMAT_VERSION,
      revision: input.revision,
      projectId: input.projectId,
      projectVersion: input.projectVersion,
      projectUpdatedAt: input.projectUpdatedAt,
    }),
  );
}

function randomBytes(crypto: Crypto, length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

async function sha256(
  input: Uint8Array,
  subtle: SubtleCrypto,
): Promise<string> {
  const digest = new Uint8Array(
    await subtle.digest('SHA-256', ownedBuffer(input)),
  );
  return Array.from(digest, (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  const block = 32_768;
  for (let offset = 0; offset < bytes.length; offset += block) {
    binary += String.fromCharCode(
      ...bytes.subarray(offset, offset + block),
    );
  }
  return btoa(binary)
    .replace(/\+/gu, '-')
    .replace(/\//gu, '_')
    .replace(/=+$/gu, '');
}

function base64UrlDecode(value: string): Uint8Array {
  if (!/^[a-zA-Z0-9_-]*$/u.test(value)) {
    throw new Error('invalid base64url');
  }
  const base64 =
    value.replace(/-/gu, '+').replace(/_/gu, '/') +
    '='.repeat((4 - (value.length % 4)) % 4);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function canonicalDate(value: string, field: string): string {
  const date = new Date(value);
  if (
    !Number.isFinite(date.valueOf()) ||
    date.toISOString() !== value
  ) {
    throw new SyncError('INVALID_INPUT', `${field} 不是有效时间。`);
  }
  return value;
}

function bytesToBlob(bytes: Uint8Array, type: string): Blob {
  const owned = new Uint8Array(bytes.byteLength);
  owned.set(bytes);
  return new Blob([owned.buffer], { type });
}

function ownedBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}
