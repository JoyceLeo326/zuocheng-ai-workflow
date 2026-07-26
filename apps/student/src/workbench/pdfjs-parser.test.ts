import { PDFDocument, StandardFonts } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import {
  createSourceFile,
  validateSourceUpload,
  type SourceFile,
} from './source-file.js';
import {
  PDFJS_WORKER_URL,
  PdfJsParser,
} from './pdfjs-parser.js';

const SOURCE_ID = 'source-01900000-0000-7000-8000-000000000101';
const ENCRYPTED_PDF_BASE64 =
  'JVBERi0xLjMKJeLjz9MKMSAwIG9iago8PAovUHJvZHVjZXIgPDdiMGUyZjdmN2Q+Cj4+CmVuZG9iagoyIDAgb2JqCjw8Ci9UeXBlIC9QYWdlcwovQ291bnQgMQovS2lkcyBbIDQgMCBSIF0KPj4KZW5kb2JqCjMgMCBvYmoKPDwKL1R5cGUgL0NhdGFsb2cKL1BhZ2VzIDIgMCBSCj4+CmVuZG9iago0IDAgb2JqCjw8Ci9UeXBlIC9QYWdlCi9SZXNvdXJjZXMgPDwKPj4KL01lZGlhQm94IFsgMC4wIDAuMCA2MTIgNzkyIF0KL1BhcmVudCAyIDAgUgo+PgplbmRvYmoKNSAwIG9iago8PAovViAyCi9SIDMKL0xlbmd0aCAxMjgKL1AgNDI5NDk2NzI5MgovRmlsdGVyIC9TdGFuZGFyZAovTyA8NjNjZDNkZDgzZmM3ZTUxMzRjNjc1NzE1YmUyNGQxYWZlYWY2ZmFhM2NjMjdjMTczMzI1NmIyNmIzNDNmMjliNj4KL1UgPDA4NjVjZmU5YTY3ZjRlMGMwOWIyMGUxNmJiNWU3MDFlMjhiZjRlNWU0ZTc1OGE0MTY0MDA0ZTU2ZmZmYTAxMDg+Cj4+CmVuZG9iagp4cmVmCjAgNgowMDAwMDAwMDAwIDY1NTM1IGYgCjAwMDAwMDAwMTUgMDAwMDAgbiAKMDAwMDAwMDA1OSAwMDAwMCBuIAowMDAwMDAwMTE4IDAwMDAwIG4gCjAwMDAwMDAxNjcgMDAwMDAgbiAKMDAwMDAwMDI2MSAwMDAwMCBuIAp0cmFpbGVyCjw8Ci9TaXplIDYKL1Jvb3QgMyAwIFIKL0luZm8gMSAwIFIKL0lEIFsgPDM1NjEzMTMyNjIzNzY0MzczODM1NjEzNjY0MzUzNTM3MzUzNjM5NjI2MjM3MzA2NDMyMzQzMjMyNjEzNzMwMzk+IDwzNTYxMzEzMjYyMzc2NDM3MzgzNTYxMzY2NDM1MzUzNzM1MzYzOTYyNjIzNzMwNjQzMjM0MzIzMjYxMzczMDM5PiBdCi9FbmNyeXB0IDUgMCBSCj4+CnN0YXJ0eHJlZgo0NzYKJSVFT0YK';
const PIXEL_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+X2h8WQAAAABJRU5ErkJggg==';

function pdfFile(bytes: Uint8Array, name = 'fixture.pdf'): File {
  const ownedBytes = new Uint8Array(bytes.byteLength);
  ownedBytes.set(bytes);
  return new File([ownedBytes.buffer], name, {
    type: 'application/pdf',
  });
}

function sourceFor(file: File): SourceFile {
  return createSourceFile({
    id: SOURCE_ID,
    upload: validateSourceUpload(file),
    sha256: 'a'.repeat(64),
  });
}

async function createTextPdf(
  pageTexts: readonly string[],
): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  document.setCreationDate(new Date(0));
  document.setModificationDate(new Date(0));
  const font = await document.embedFont(StandardFonts.Helvetica);
  for (const text of pageTexts) {
    const page = document.addPage([612, 792]);
    page.drawText(text, {
      x: 48,
      y: 720,
      size: 12,
      font,
    });
  }
  return document.save({ useObjectStreams: false });
}

async function createTextLayoutPdf(): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  const page = document.addPage([612, 792]);
  page.drawText('Alpha', { x: 48, y: 720, size: 12, font });
  page.drawText('Beta', { x: 120, y: 720, size: 12, font });
  page.drawText('Second line', { x: 48, y: 680, size: 12, font });
  return document.save({ useObjectStreams: false });
}

async function createImageOnlyPdf(): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const image = await document.embedPng(
    decodeBase64(PIXEL_PNG_BASE64),
  );
  const page = document.addPage([612, 792]);
  page.drawImage(image, {
    x: 48,
    y: 680,
    width: 64,
    height: 64,
  });
  return document.save({ useObjectStreams: false });
}

function createFragmentedChinesePdf(): Uint8Array {
  const cmap = [
    '/CIDInit /ProcSet findresource begin',
    '12 dict begin begincmap',
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
    '/CMapName /Test-UCS def /CMapType 2 def',
    '1 begincodespacerange <0000> <FFFF> endcodespacerange',
    '4 beginbfchar',
    '<0001> <4EBA>',
    '<0002> <5DE5>',
    '<0003> <667A>',
    '<0004> <80FD>',
    'endbfchar endcmap CMapName currentdict /CMap defineresource pop end end',
  ].join('\n');
  const content = [
    'BT /F1 12 Tf 1 0 0 1 48 720 Tm <0001> Tj ET',
    'BT /F2 13 Tf 1 0 0 1 60 720 Tm <0002> Tj ET',
    'BT /F3 12 Tf 1 0 0 1 73 720 Tm <0003> Tj ET',
    'BT /F4 13 Tf 1 0 0 1 85 720 Tm <0004> Tj ET',
  ].join('\n');
  const type0Font = (name: string) =>
    `<< /Type /Font /Subtype /Type0 /BaseFont /${name} ` +
    '/Encoding /Identity-H /DescendantFonts [5 0 R] /ToUnicode 6 0 R >>';
  const encoder = new TextEncoder();
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ' +
      '/Resources << /Font << /F1 4 0 R /F2 9 0 R /F3 10 0 R /F4 11 0 R >> >> ' +
      '/Contents 8 0 R >>',
    type0Font('TestChinese1'),
    '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /TestChinese ' +
      '/CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> ' +
      '/FontDescriptor 7 0 R /W [1 [1000 1000 1000 1000]] /CIDToGIDMap /Identity >>',
    `<< /Length ${encoder.encode(cmap).length} >>\nstream\n${cmap}\nendstream`,
    '<< /Type /FontDescriptor /FontName /TestChinese /Flags 4 ' +
      '/FontBBox [0 -200 1000 900] /ItalicAngle 0 /Ascent 880 /Descent -120 ' +
      '/CapHeight 700 /StemV 80 >>',
    `<< /Length ${encoder.encode(content).length} >>\nstream\n${content}\nendstream`,
    type0Font('TestChinese2'),
    type0Font('TestChinese3'),
    type0Font('TestChinese4'),
  ];
  let pdf = '%PDF-1.7\n%AAAA\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(encoder.encode(pdf).length);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xrefOffset = encoder.encode(pdf).length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join('');
  pdf +=
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n` +
    `startxref\n${xrefOffset}\n%%EOF\n`;
  return encoder.encode(pdf);
}

function decodeBase64(value: string): Uint8Array {
  return Uint8Array.from(globalThis.atob(value), (character) =>
    character.charCodeAt(0),
  );
}

describe('PDF.js browser parser adapter', () => {
  it('configures the official PDF.js worker as a Vite asset', () => {
    expect(PDFJS_WORKER_URL).toContain('pdf.worker.min.mjs');
  });

  it('extracts real text and page numbers from a generated 25-page PDF', async () => {
    const expectedTexts = Array.from(
      { length: 25 },
      (_, index) => `Traceable source page ${index + 1}`,
    );
    const file = pdfFile(await createTextPdf(expectedTexts));
    const parser = new PdfJsParser();

    const result = await parser.parsePdf({
      file,
      source: sourceFor(file),
    });

    expect(result.pageCount).toBe(25);
    expect(result.pages).toHaveLength(25);
    expect(result.pages.map((page) => page.pageNumber)).toEqual(
      Array.from({ length: 25 }, (_, index) => index + 1),
    );
    expect(result.pages.map((page) => page.text)).toEqual(expectedTexts);
  });

  it('joins same-line items with spaces and preserves a line break', async () => {
    const file = pdfFile(await createTextLayoutPdf(), 'layout.pdf');

    const result = await new PdfJsParser().parsePdf({
      file,
      source: sourceFor(file),
    });

    expect(result.pages).toEqual([
      {
        pageNumber: 1,
        text: 'Alpha Beta\nSecond line',
      },
    ]);
  });

  it('does not insert spaces between adjacent fragmented Chinese text items', async () => {
    const file = pdfFile(
      createFragmentedChinesePdf(),
      'fragmented-chinese.pdf',
    );

    const result = await new PdfJsParser().parsePdf({
      file,
      source: sourceFor(file),
    });

    expect(result.pages).toEqual([
      {
        pageNumber: 1,
        text: '人工智能',
      },
    ]);
  });

  it('maps a real encrypted PDF to ENCRYPTED_PDF', async () => {
    const file = pdfFile(
      decodeBase64(ENCRYPTED_PDF_BASE64),
      'encrypted.pdf',
    );

    await expect(
      new PdfJsParser().parsePdf({
        file,
        source: sourceFor(file),
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        name: 'SourceParserPortError',
        code: 'ENCRYPTED_PDF',
      }),
    );
  });

  it('maps damaged PDF bytes to CORRUPT_PDF', async () => {
    const file = pdfFile(
      new TextEncoder().encode('%PDF-1.7\nnot a valid document'),
      'damaged.pdf',
    );

    await expect(
      new PdfJsParser().parsePdf({
        file,
        source: sourceFor(file),
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        name: 'SourceParserPortError',
        code: 'CORRUPT_PDF',
      }),
    );
  });

  it('maps a valid image-only PDF to OCR_REQUIRED instead of corruption', async () => {
    const file = pdfFile(await createImageOnlyPdf(), 'image-only.pdf');

    await expect(
      new PdfJsParser().parsePdf({
        file,
        source: sourceFor(file),
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        name: 'SourceParserPortError',
        code: 'OCR_REQUIRED',
      }),
    );
  });
});
