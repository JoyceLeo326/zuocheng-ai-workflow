import { describe, expect, it } from 'vitest';
import {
  createSourceFile,
  validateSourceUpload,
  type SourceFile,
} from './source-file.js';
import {
  TEXT_CHUNK_MAX_CHARACTERS,
  parseBrowserSourceFile,
} from './text-parsers.js';
import type { BrowserSourceParserError } from './text-parsers.js';

const SOURCE_ID = 'source-01900000-0000-7000-8000-000000000301';
const PIXEL_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+X2h8WQAAAABJRU5ErkJggg==';

async function sha256(bytes: Uint8Array): Promise<string> {
  const ownedBytes = new Uint8Array(bytes.byteLength);
  ownedBytes.set(bytes);
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    ownedBytes.buffer,
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

async function sourceFor(file: File): Promise<SourceFile> {
  return createSourceFile({
    id: SOURCE_ID,
    upload: validateSourceUpload(file),
    sha256: await sha256(new Uint8Array(await file.arrayBuffer())),
  });
}

function textFile(
  bytes: Uint8Array,
  name: string,
  type: string,
): File {
  const ownedBytes = new Uint8Array(bytes.byteLength);
  ownedBytes.set(bytes);
  return new File([ownedBytes.buffer], name, { type });
}

function encodeUtf16(
  text: string,
  endianness: 'little' | 'big',
): Uint8Array {
  const bytes = new Uint8Array(2 + text.length * 2);
  bytes.set(endianness === 'little' ? [0xff, 0xfe] : [0xfe, 0xff]);
  for (let index = 0; index < text.length; index += 1) {
    const codeUnit = text.charCodeAt(index);
    const offset = 2 + index * 2;
    bytes[offset] =
      endianness === 'little' ? codeUnit & 0xff : codeUnit >> 8;
    bytes[offset + 1] =
      endianness === 'little' ? codeUnit >> 8 : codeUnit & 0xff;
  }
  return bytes;
}

function decodeBase64(value: string): Uint8Array {
  return Uint8Array.from(globalThis.atob(value), (character) =>
    character.charCodeAt(0),
  );
}

describe('zero-server-cost browser source parsers', () => {
  it('decodes a UTF-8 BOM TXT file into traceable hashed chunks', async () => {
    const text = '第一段 😀\nSecond paragraph';
    const payload = new TextEncoder().encode(text);
    const bytes = new Uint8Array(3 + payload.length);
    bytes.set([0xef, 0xbb, 0xbf]);
    bytes.set(payload, 3);
    const file = textFile(bytes, 'notes.txt', 'text/plain');

    const result = await parseBrowserSourceFile({
      file,
      source: await sourceFor(file),
      sourceFileVersion: 3,
    });

    expect(result).toMatchObject({
      status: 'parsed',
      kind: 'text',
      encoding: 'utf-8',
      characterOffsetUnit: 'utf-16-code-unit',
    });
    if (result.status !== 'parsed') {
      throw new Error('expected parsed text');
    }
    expect(result.chunks).toEqual([
      {
        sourceFileId: SOURCE_ID,
        sourceFileVersion: 3,
        ordinal: 0,
        pageNumber: 1,
        pageLabel: '1',
        characterStart: 0,
        characterEnd: text.length,
        text,
        contentSha256: await sha256(new TextEncoder().encode(text)),
      },
    ]);
  });

  it.each([
    ['little', 'utf-16le'],
    ['big', 'utf-16be'],
  ] as const)(
    'decodes BOM-marked UTF-16 %s-endian Markdown',
    async (endianness, expectedEncoding) => {
      const text = '# 标题\n\n- 可追溯';
      const file = textFile(
        encodeUtf16(text, endianness),
        'outline.md',
        'text/markdown',
      );

      const result = await parseBrowserSourceFile({
        file,
        source: await sourceFor(file),
        sourceFileVersion: 1,
      });

      expect(result).toMatchObject({
        status: 'parsed',
        kind: 'markdown',
        encoding: expectedEncoding,
        chunks: [{ text }],
      });
    },
  );

  it('falls back to the browser GB18030 decoder for legacy Chinese TXT', async () => {
    const file = textFile(
      Uint8Array.from([0xd6, 0xd0, 0xce, 0xc4, 0x0a, 0x41]),
      'legacy.txt',
      'text/plain',
    );

    const result = await parseBrowserSourceFile({
      file,
      source: await sourceFor(file),
      sourceFileVersion: 2,
    });

    expect(result).toMatchObject({
      status: 'parsed',
      kind: 'text',
      encoding: 'gb18030',
      chunks: [{ text: '中文\nA' }],
    });
  });

  it('splits long text with exact ranges, intact surrogate pairs, and verifiable hashes', async () => {
    const text =
      `${'A'.repeat(TEXT_CHUNK_MAX_CHARACTERS - 1)}😀\n` +
      `${'B'.repeat(TEXT_CHUNK_MAX_CHARACTERS)}\n尾段`;
    const file = textFile(
      new TextEncoder().encode(text),
      'long.txt',
      'text/plain',
    );

    const result = await parseBrowserSourceFile({
      file,
      source: await sourceFor(file),
      sourceFileVersion: 4,
    });

    if (result.status !== 'parsed') {
      throw new Error('expected parsed text');
    }
    expect(result.chunks.length).toBeGreaterThan(1);
    for (const [index, chunk] of result.chunks.entries()) {
      expect(chunk.ordinal).toBe(index);
      expect(chunk.text.length).toBeLessThanOrEqual(
        TEXT_CHUNK_MAX_CHARACTERS,
      );
      expect(chunk.text).toBe(
        text.slice(chunk.characterStart, chunk.characterEnd),
      );
      expect(chunk.contentSha256).toBe(
        await sha256(new TextEncoder().encode(chunk.text)),
      );
      expect(chunk.text).not.toMatch(/^[\uDC00-\uDFFF]/u);
      expect(chunk.text).not.toMatch(/[\uD800-\uDBFF]$/u);
      if (index > 0) {
        expect(chunk.characterStart).toBeGreaterThanOrEqual(
          result.chunks[index - 1]?.characterEnd ?? 0,
        );
      }
    }
  });

  it('returns OCR_REQUIRED with preview metadata for an image instead of invented text', async () => {
    const bytes = decodeBase64(PIXEL_PNG_BASE64);
    const file = textFile(bytes, 'scan.png', 'image/png');
    const source = await sourceFor(file);

    const result = await parseBrowserSourceFile({
      file,
      source,
      sourceFileVersion: 1,
    });

    expect(result).toEqual({
      status: 'ocr-required',
      code: 'OCR_REQUIRED',
      kind: 'image',
      chunks: [],
      preview: {
        sourceFileId: SOURCE_ID,
        fileName: 'scan.png',
        mimeType: 'image/png',
        extension: '.png',
        sizeBytes: bytes.length,
        contentSha256: source.sha256,
        widthPixels: 1,
        heightPixels: 1,
      },
    });
  });

  it('fails closed when bytes no longer match the validated source hash', async () => {
    const original = textFile(
      new TextEncoder().encode('original'),
      'notes.txt',
      'text/plain',
    );
    const changed = textFile(
      new TextEncoder().encode('changed!'),
      'notes.txt',
      'text/plain',
    );

    await expect(
      parseBrowserSourceFile({
        file: changed,
        source: await sourceFor(original),
        sourceFileVersion: 1,
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<BrowserSourceParserError>>({
        name: 'BrowserSourceParserError',
        code: 'SOURCE_CONTENT_MISMATCH',
      }),
    );
  });
});
