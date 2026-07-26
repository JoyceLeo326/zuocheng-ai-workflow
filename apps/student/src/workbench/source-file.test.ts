import { describe, expect, it, vi } from 'vitest';
import {
  MAX_SOURCE_FILE_BYTES,
  SourceFileDomainError,
  SourceFileValidationError,
  SourceParserPortError,
  beginSourceParsing,
  computeSourceFileSha256,
  createSourceFile,
  isDuplicateSourceHash,
  replaceFailedSource,
  retrySourceParsing,
  runPdfParsing,
  validateSourceUpload,
  type PdfParserPort,
  type SourceFile,
} from './source-file.js';

const SOURCE_ID = 'source-01900000-0000-7000-8000-000000000001';
const REPLACEMENT_SOURCE_ID =
  'source-01900000-0000-7000-8000-000000000002';
const SHA256_ABC =
  'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

function uploadCandidate(
  name: string,
  type: string,
  size = 128,
): Pick<File, 'name' | 'size' | 'type'> {
  return { name, size, type };
}

function pdfFile(contents = '%PDF-1.7 fixture'): File {
  return new File([contents], 'research.pdf', {
    type: 'application/pdf',
  });
}

function sourceFile(): SourceFile {
  return createSourceFile({
    id: SOURCE_ID,
    upload: validateSourceUpload(pdfFile()),
    sha256: 'a'.repeat(64),
  });
}

describe('workbench source files', () => {
  it.each([
    ['paper.PDF', 'application/pdf', 'pdf'],
    [
      'brief.docx',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'docx',
    ],
    [
      'slides.pptx',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'pptx',
    ],
    ['notes.txt', 'text/plain', 'text'],
    ['notes.md', 'text/markdown', 'markdown'],
    ['notes.markdown', 'text/plain', 'markdown'],
    ['figure.png', 'image/png', 'image'],
    ['photo.jpg', 'image/jpeg', 'image'],
    ['photo.jpeg', 'image/jpeg', 'image'],
    ['diagram.webp', 'image/webp', 'image'],
    ['animation.gif', 'image/gif', 'image'],
    ['photo.avif', 'image/avif', 'image'],
  ] as const)(
    'accepts the explicit upload pair %s / %s',
    (name, mimeType, expectedKind) => {
      expect(
        validateSourceUpload(uploadCandidate(name, mimeType)),
      ).toMatchObject({
        name,
        mimeType,
        kind: expectedKind,
        extension: name.slice(name.lastIndexOf('.')).toLowerCase(),
        sizeBytes: 128,
      });
    },
  );

  it.each([
    ['paper.pdf', 'application/octet-stream'],
    ['paper.pdf', 'text/plain'],
    ['brief.docx', 'application/zip'],
    [
      'brief.docx',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    ],
    ['slides.pptx', 'application/pdf'],
    ['notes.txt', 'text/markdown'],
    ['notes.md', 'application/pdf'],
    ['figure.png', 'image/jpeg'],
    ['photo.jpg', 'image/png'],
    ['paper.pdf', ''],
  ])('rejects MIME and extension mismatch %s / %s', (name, type) => {
    expect(() =>
      validateSourceUpload(uploadCandidate(name, type)),
    ).toThrow(
      expect.objectContaining({
        code: 'MIME_EXTENSION_MISMATCH',
      }),
    );
  });

  it.each([
    'archive.zip',
    'legacy.doc',
    'legacy.ppt',
    'vector.svg',
    'program.exe',
    'no-extension',
  ])('rejects unsupported extension %s', (name) => {
    expect(() =>
      validateSourceUpload(
        uploadCandidate(name, 'application/octet-stream'),
      ),
    ).toThrow(
      expect.objectContaining({
        code: 'UNSUPPORTED_EXTENSION',
      }),
    );
  });

  it('rejects empty and oversized files before parsing or hashing', () => {
    expect(() =>
      validateSourceUpload(uploadCandidate('empty.pdf', 'application/pdf', 0)),
    ).toThrow(
      expect.objectContaining({
        code: 'EMPTY_FILE',
      }),
    );
    expect(() =>
      validateSourceUpload(
        uploadCandidate(
          'huge.pdf',
          'application/pdf',
          MAX_SOURCE_FILE_BYTES + 1,
        ),
      ),
    ).toThrow(
      expect.objectContaining({
        code: 'FILE_TOO_LARGE',
      }),
    );
  });

  it.each([
    '../paper.pdf',
    '..\\paper.pdf',
    'paper.exe.pdf',
    'CON.pdf',
    'brief\u202eexe.pdf',
    '.pdf',
    ' brief.pdf',
    'brief.pdf ',
    'brief?.pdf',
  ])('rejects dangerous file name %s', (name) => {
    expect(() =>
      validateSourceUpload(uploadCandidate(name, 'application/pdf')),
    ).toThrow(
      expect.objectContaining({
        code: 'UNSAFE_FILE_NAME',
      }),
    );
  });

  it('uses Web Crypto SHA-256 and detects an existing canonical digest', async () => {
    const file = new File(['abc'], 'notes.txt', { type: 'text/plain' });

    await expect(computeSourceFileSha256(file)).resolves.toBe(SHA256_ABC);
    expect(
      isDuplicateSourceHash(SHA256_ABC, [
        { sha256: 'f'.repeat(64) },
        { sha256: SHA256_ABC },
      ]),
    ).toBe(true);
    expect(
      isDuplicateSourceHash(SHA256_ABC, [{ sha256: 'f'.repeat(64) }]),
    ).toBe(false);
  });

  it('rejects malformed hashes instead of treating them as duplicate keys', () => {
    expect(() => isDuplicateSourceHash('not-a-sha256', [])).toThrow(
      expect.objectContaining({
        code: 'INVALID_SHA256',
      }),
    );
    expect(() =>
      createSourceFile({
        id: SOURCE_ID,
        upload: validateSourceUpload(pdfFile()),
        sha256: 'ABC',
      }),
    ).toThrow(
      expect.objectContaining({
        code: 'INVALID_SHA256',
      }),
    );
  });

  it('retains all 25 PDF page numbers as 25 traceable source chunks', async () => {
    const file = pdfFile();
    const initial = sourceFile();
    const parsing = beginSourceParsing(initial);
    const port: PdfParserPort = {
      parsePdf: vi.fn(async ({ file: receivedFile, source }) => {
        expect(receivedFile).toBe(file);
        expect(source.id).toBe(SOURCE_ID);
        return {
          pageCount: 25,
          pages: Array.from({ length: 25 }, (_, index) => ({
            pageNumber: index + 1,
            text: `Original page ${index + 1}`,
          })),
        };
      }),
    };

    const parsed = await runPdfParsing(parsing, file, port);

    expect(port.parsePdf).toHaveBeenCalledOnce();
    expect(parsed.parsing.status).toBe('parsed');
    if (parsed.parsing.status !== 'parsed') {
      throw new Error('Expected parsed source');
    }
    expect(parsed.parsing.pageCount).toBe(25);
    expect(parsed.parsing.chunks).toHaveLength(25);
    expect(parsed.parsing.chunks.map((chunk) => chunk.pageNumber)).toEqual(
      Array.from({ length: 25 }, (_, index) => index + 1),
    );
    expect(parsed.parsing.chunks).toEqual(
      Array.from({ length: 25 }, (_, index) => ({
        kind: 'pdf-page',
        sourceFileId: SOURCE_ID,
        ordinal: index,
        pageNumber: index + 1,
        text: `Original page ${index + 1}`,
      })),
    );
  });

  it.each([
    {
      reason: 'missing page',
      result: {
        pageCount: 2,
        pages: [{ pageNumber: 1, text: 'Page one' }],
      },
    },
    {
      reason: 'duplicate page number',
      result: {
        pageCount: 2,
        pages: [
          { pageNumber: 1, text: 'Page one' },
          { pageNumber: 1, text: 'Page one again' },
        ],
      },
    },
    {
      reason: 'out-of-order page number',
      result: {
        pageCount: 2,
        pages: [
          { pageNumber: 2, text: 'Page two' },
          { pageNumber: 1, text: 'Page one' },
        ],
      },
    },
    {
      reason: 'non-integer page count',
      result: {
        pageCount: 1.5,
        pages: [{ pageNumber: 1, text: 'Page one' }],
      },
    },
  ])('fails closed for invalid parser output: $reason', async ({ result }) => {
    const port: PdfParserPort = {
      parsePdf: vi.fn(async () => result),
    };

    const failed = await runPdfParsing(
      beginSourceParsing(sourceFile()),
      pdfFile(),
      port,
    );

    expect(failed.parsing).toMatchObject({
      status: 'failed',
      attempt: 1,
      code: 'INVALID_PARSER_OUTPUT',
      retryable: true,
      replaceable: true,
    });
  });

  it('turns parser failure into explicit retry and replacement transitions', async () => {
    const parserUnavailable = new SourceParserPortError(
      'PARSER_UNAVAILABLE',
    );
    const failingPort: PdfParserPort = {
      parsePdf: vi.fn(async () => {
        throw parserUnavailable;
      }),
    };
    const initial = sourceFile();
    const firstAttempt = beginSourceParsing(initial);
    const failed = await runPdfParsing(
      firstAttempt,
      pdfFile(),
      failingPort,
    );

    expect(failed.parsing).toEqual({
      status: 'failed',
      attempt: 1,
      code: 'PARSER_UNAVAILABLE',
      retryable: true,
      replaceable: true,
    });

    const retrying = retrySourceParsing(failed);
    expect(retrying.parsing).toEqual({
      status: 'parsing',
      attempt: 2,
    });
    const successfulPort: PdfParserPort = {
      parsePdf: vi.fn(async () => ({
        pageCount: 1,
        pages: [{ pageNumber: 1, text: 'Text from the injected parser' }],
      })),
    };
    const parsed = await runPdfParsing(
      retrying,
      pdfFile(),
      successfulPort,
    );
    expect(parsed.parsing).toMatchObject({
      status: 'parsed',
      attempt: 2,
      pageCount: 1,
    });

    const replacement = replaceFailedSource(
      failed,
      REPLACEMENT_SOURCE_ID,
    );
    expect(replacement.parsing).toEqual({
      status: 'replaced',
      attempt: 1,
      replacementSourceId: REPLACEMENT_SOURCE_ID,
    });
  });

  it('does not parse a non-PDF source or permit invalid state transitions', async () => {
    const textFile = new File(['real text'], 'notes.txt', {
      type: 'text/plain',
    });
    const textSource = createSourceFile({
      id: SOURCE_ID,
      upload: validateSourceUpload(textFile),
      sha256: 'b'.repeat(64),
    });
    const port: PdfParserPort = {
      parsePdf: vi.fn(async () => ({
        pageCount: 1,
        pages: [{ pageNumber: 1, text: 'fabricated' }],
      })),
    };

    await expect(
      runPdfParsing(beginSourceParsing(textSource), textFile, port),
    ).rejects.toEqual(
      expect.objectContaining({
        code: 'PDF_SOURCE_REQUIRED',
      }),
    );
    expect(port.parsePdf).not.toHaveBeenCalled();
    expect(() => retrySourceParsing(sourceFile())).toThrow(
      SourceFileDomainError,
    );
    expect(() =>
      replaceFailedSource(sourceFile(), REPLACEMENT_SOURCE_ID),
    ).toThrow(SourceFileDomainError);
  });

  it('exports stable non-disclosing validation errors', () => {
    expect(() =>
      validateSourceUpload(uploadCandidate('paper.pdf', 'text/plain')),
    ).toThrow(SourceFileValidationError);
  });
});
