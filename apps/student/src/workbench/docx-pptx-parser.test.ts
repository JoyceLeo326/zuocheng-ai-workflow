import { strToU8, zipSync, type Zippable } from 'fflate';
import { describe, expect, it } from 'vitest';
import {
  createSourceFile,
  validateSourceUpload,
  type SourceFile,
} from './source-file.js';
import {
  parseBrowserOfficeFile,
  type BrowserOfficeParserError,
} from './docx-pptx-parser.js';

const SOURCE_ID = 'source-01900000-0000-7000-8000-000000000401';
const DOCX_MEDIA_TYPE =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const PPTX_MEDIA_TYPE =
  'application/vnd.openxmlformats-officedocument.presentationml.presentation';

const PACKAGE_RELATIONSHIPS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="officeDocument" Target="document.xml"/>
</Relationships>`;

const DOCX_CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Override PartName="/word/document.xml"
    ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

const PPTX_CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Override PartName="/ppt/presentation.xml"
    ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
</Types>`;

function officeFile(
  entries: Readonly<Record<string, string>>,
  name: string,
  mediaType: string,
): File {
  const archive: Zippable = {};
  for (const [path, xml] of Object.entries(entries)) {
    archive[path] = strToU8(xml);
  }
  const bytes = zipSync(archive, { level: 6 });
  const ownedBytes = new Uint8Array(bytes.byteLength);
  ownedBytes.set(bytes);
  return new File([ownedBytes.buffer], name, { type: mediaType });
}

function binaryOfficeFile(
  bytes: Uint8Array,
  name: string,
  mediaType: string,
): File {
  const ownedBytes = new Uint8Array(bytes.byteLength);
  ownedBytes.set(bytes);
  return new File([ownedBytes.buffer], name, { type: mediaType });
}

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

async function expectedChunks(
  blocks: ReadonlyArray<
    Readonly<{ text: string; pageNumber: number; pageLabel: string }>
  >,
  sourceFileVersion: number,
) {
  let cursor = 0;
  return Promise.all(
    blocks.map(async (block, ordinal) => {
      const characterStart = cursor;
      const characterEnd = characterStart + block.text.length;
      cursor = characterEnd + 1;
      return {
        sourceFileId: SOURCE_ID,
        sourceFileVersion,
        ordinal,
        pageNumber: block.pageNumber,
        pageLabel: block.pageLabel,
        characterStart,
        characterEnd,
        text: block.text,
        contentSha256: await sha256(
          new TextEncoder().encode(block.text),
        ),
      };
    }),
  );
}

function markZipEntriesEncrypted(bytes: Uint8Array): Uint8Array {
  const encrypted = Uint8Array.from(bytes);
  const view = new DataView(
    encrypted.buffer,
    encrypted.byteOffset,
    encrypted.byteLength,
  );
  for (let offset = 0; offset + 10 <= encrypted.length; offset += 1) {
    const signature = view.getUint32(offset, true);
    if (signature === 0x04034b50) {
      view.setUint16(offset + 6, view.getUint16(offset + 6, true) | 1, true);
    } else if (signature === 0x02014b50) {
      view.setUint16(offset + 8, view.getUint16(offset + 8, true) | 1, true);
    }
  }
  return encrypted;
}

describe('browser DOCX/PPTX OOXML parser', () => {
  it('extracts DOCX paragraphs and table cells in document order', async () => {
    const documentXml = `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>Intro</w:t></w:r><w:r><w:t xml:space="preserve"> paragraph</w:t></w:r></w:p>
    <w:tbl><w:tr>
      <w:tc><w:p><w:r><w:t>Cell A</w:t></w:r></w:p></w:tc>
      <w:tc><w:p><w:r><w:t>Cell B</w:t></w:r></w:p></w:tc>
    </w:tr></w:tbl>
    <w:p><w:r><w:t>Last &amp; final</w:t></w:r></w:p>
  </w:body>
</w:document>`;
    const file = officeFile(
      {
        '[Content_Types].xml': DOCX_CONTENT_TYPES,
        '_rels/.rels': PACKAGE_RELATIONSHIPS,
        'word/document.xml': documentXml,
      },
      'report.docx',
      DOCX_MEDIA_TYPE,
    );

    const result = await parseBrowserOfficeFile({
      file,
      source: await sourceFor(file),
      sourceFileVersion: 3,
    });

    const blocks = [
      { text: 'Intro paragraph', pageNumber: 1, pageLabel: 'Document' },
      { text: 'Cell A', pageNumber: 1, pageLabel: 'Document' },
      { text: 'Cell B', pageNumber: 1, pageLabel: 'Document' },
      { text: 'Last & final', pageNumber: 1, pageLabel: 'Document' },
    ];
    expect(result).toEqual({
      status: 'parsed',
      kind: 'docx',
      pageCount: 1,
      characterOffsetUnit: 'utf-16-code-unit',
      chunks: await expectedChunks(blocks, 3),
    });
  });

  it('sorts PPTX slides numerically and preserves shape text order', async () => {
    const slide = (body: string) => `<?xml version="1.0" encoding="UTF-8"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
  xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <p:cSld><p:spTree>${body}</p:spTree></p:cSld>
</p:sld>`;
    const shape = (paragraphs: readonly string[]) =>
      `<p:sp><p:txBody>${paragraphs
        .map(
          (text) =>
            `<a:p><a:r><a:t>${text}</a:t></a:r></a:p>`,
        )
        .join('')}</p:txBody></p:sp>`;
    const file = officeFile(
      {
        '[Content_Types].xml': PPTX_CONTENT_TYPES,
        '_rels/.rels': PACKAGE_RELATIONSHIPS,
        'ppt/presentation.xml':
          '<p:presentation xmlns:p="urn:presentation"/>',
        'ppt/slides/slide2.xml': slide(shape(['Slide two'])),
        'ppt/slides/slide1.xml': slide(
          shape(['Title']) + shape(['Body first', 'Body second']),
        ),
      },
      'deck.pptx',
      PPTX_MEDIA_TYPE,
    );

    const result = await parseBrowserOfficeFile({
      file,
      source: await sourceFor(file),
      sourceFileVersion: 2,
    });

    const blocks = [
      { text: 'Title', pageNumber: 1, pageLabel: 'Slide 1' },
      { text: 'Body first', pageNumber: 1, pageLabel: 'Slide 1' },
      { text: 'Body second', pageNumber: 1, pageLabel: 'Slide 1' },
      { text: 'Slide two', pageNumber: 2, pageLabel: 'Slide 2' },
    ];
    expect(result).toEqual({
      status: 'parsed',
      kind: 'pptx',
      pageCount: 2,
      characterOffsetUnit: 'utf-16-code-unit',
      chunks: await expectedChunks(blocks, 2),
    });
  });

  it('rejects a valid OOXML package with no extractable text', async () => {
    const file = officeFile(
      {
        '[Content_Types].xml': DOCX_CONTENT_TYPES,
        '_rels/.rels': PACKAGE_RELATIONSHIPS,
        'word/document.xml':
          '<w:document xmlns:w="urn:w"><w:body><w:p/></w:body></w:document>',
      },
      'empty.docx',
      DOCX_MEDIA_TYPE,
    );

    await expect(
      parseBrowserOfficeFile({
        file,
        source: await sourceFor(file),
        sourceFileVersion: 1,
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<BrowserOfficeParserError>>({
        name: 'BrowserOfficeParserError',
        code: 'EMPTY_OOXML_TEXT',
      }),
    );
  });

  it('rejects a damaged package as corrupt OOXML', async () => {
    const file = binaryOfficeFile(
      new TextEncoder().encode('PK\u0003\u0004damaged archive'),
      'damaged.pptx',
      PPTX_MEDIA_TYPE,
    );

    await expect(
      parseBrowserOfficeFile({
        file,
        source: await sourceFor(file),
        sourceFileVersion: 1,
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<BrowserOfficeParserError>>({
        name: 'BrowserOfficeParserError',
        code: 'CORRUPT_OOXML',
      }),
    );
  });

  it('rejects ZIP-encrypted OOXML with an explicit error', async () => {
    const plain = officeFile(
      {
        '[Content_Types].xml': DOCX_CONTENT_TYPES,
        '_rels/.rels': PACKAGE_RELATIONSHIPS,
        'word/document.xml':
          '<w:document xmlns:w="urn:w"><w:body><w:p><w:r><w:t>Secret</w:t></w:r></w:p></w:body></w:document>',
      },
      'plain.docx',
      DOCX_MEDIA_TYPE,
    );
    const encryptedBytes = markZipEntriesEncrypted(
      new Uint8Array(await plain.arrayBuffer()),
    );
    const file = binaryOfficeFile(
      encryptedBytes,
      'encrypted.docx',
      DOCX_MEDIA_TYPE,
    );

    await expect(
      parseBrowserOfficeFile({
        file,
        source: await sourceFor(file),
        sourceFileVersion: 1,
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<BrowserOfficeParserError>>({
        name: 'BrowserOfficeParserError',
        code: 'ENCRYPTED_OOXML',
      }),
    );
  });
});
