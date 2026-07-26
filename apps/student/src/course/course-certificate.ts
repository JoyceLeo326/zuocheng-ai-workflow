import type { PDFFont, PDFPage, RGB } from 'pdf-lib';
import {
  LOCAL_7_DAY_COURSE,
  courseOutcome,
  type CourseDefinition,
  type CourseEnrollment,
} from './course-model.js';

export type CourseCertificateInput = Readonly<{
  learnerName: string;
  enrollment: CourseEnrollment;
  course?: CourseDefinition;
  issuedAt?: string;
}>;

export type CourseCertificateResult = Readonly<{
  blob: Blob;
  fileName: string;
  certificateId: string;
}>;

export type CourseCertificateErrorCode =
  | 'NAME_REQUIRED'
  | 'NOT_ELIGIBLE'
  | 'INVALID_ISSUED_AT'
  | 'UNSUPPORTED_TEXT';

export class CourseCertificateError extends Error {
  constructor(readonly code: CourseCertificateErrorCode) {
    super(`Course certificate rejected: ${code}`);
    this.name = 'CourseCertificateError';
  }
}

export async function generateCourseCertificate(
  input: CourseCertificateInput,
): Promise<CourseCertificateResult> {
  const learnerName = input.learnerName.trim();
  if (learnerName.length === 0 || learnerName.length > 80) {
    throw new CourseCertificateError('NAME_REQUIRED');
  }
  const course = input.course ?? LOCAL_7_DAY_COURSE;
  if (!courseOutcome(input.enrollment, course).certificateEligible) {
    throw new CourseCertificateError('NOT_ELIGIBLE');
  }
  const issuedAt = input.issuedAt ?? new Date().toISOString();
  const issuedDate = new Date(issuedAt);
  if (Number.isNaN(issuedDate.valueOf())) {
    throw new CourseCertificateError('INVALID_ISSUED_AT');
  }

  const certificateId = courseCertificateId(
    input.enrollment.id,
    course.id,
    issuedAt,
  );
  const { PDFDocument, StandardFonts, rgb } = await import('pdf-lib');
  const document = await PDFDocument.create();
  document.setTitle(`${course.title}｜结课证书`);
  document.setSubject(`Enrollment ${input.enrollment.id}`);
  document.setAuthor('做成');
  document.setCreator('做成课程中心');
  document.setProducer('pdf-lib');
  document.setCreationDate(issuedDate);
  document.setModificationDate(issuedDate);

  let regular = await document.embedFont(StandardFonts.Helvetica);
  let bold = await document.embedFont(StandardFonts.HelveticaBold);
  const certificateText = [
    '结课证书',
    learnerName,
    course.title,
    '已完成全部课程与必交作业',
    `证书编号 ${certificateId}`,
    formatIssuedDate(issuedDate),
  ];
  try {
    for (const text of certificateText) {
      regular.encodeText(text);
      bold.encodeText(text);
    }
  } catch {
    const [{ default: fontkit }, { default: fontData }] =
      await Promise.all([
        import('@pdf-lib/fontkit'),
        import(
          '@fontsource/noto-sans-sc/files/noto-sans-sc-chinese-simplified-400-normal.woff?inline'
        ),
      ]);
    document.registerFontkit(fontkit);
    regular = await document.embedFont(fontData, { subset: true });
    bold = regular;
    try {
      for (const text of certificateText) {
        regular.encodeText(text);
      }
    } catch {
      throw new CourseCertificateError('UNSUPPORTED_TEXT');
    }
  }

  const width = 841.89;
  const height = 595.28;
  const page = document.addPage([width, height]);
  page.drawRectangle({
    x: 22,
    y: 22,
    width: width - 44,
    height: height - 44,
    borderColor: rgb(0.08, 0.08, 0.07),
    borderWidth: 2,
    color: rgb(0.98, 0.97, 0.92),
  });
  page.drawRectangle({
    x: 38,
    y: 38,
    width: width - 76,
    height: height - 76,
    borderColor: rgb(0.62, 0.79, 0.12),
    borderWidth: 1,
  });
  page.drawRectangle({
    x: 70,
    y: height - 102,
    width: 42,
    height: 42,
    color: rgb(0.78, 1, 0.24),
  });
  page.drawRectangle({
    x: 87,
    y: height - 85,
    width: 8,
    height: 8,
    color: rgb(0.05, 0.05, 0.05),
  });
  page.drawText('做成', {
    x: 126,
    y: height - 84,
    size: 18,
    font: bold,
    color: rgb(0.08, 0.08, 0.07),
  });

  const certificateInk = rgb(0.08, 0.08, 0.07);
  drawCentered(
    page,
    '结课证书',
    height - 180,
    34,
    bold,
    width,
    certificateInk,
  );
  drawCentered(
    page,
    'CERTIFICATE OF COMPLETION',
    height - 208,
    10,
    regular,
    width,
    certificateInk,
  );
  drawCentered(
    page,
    learnerName,
    height - 288,
    28,
    bold,
    width,
    certificateInk,
  );
  drawCentered(
    page,
    `已完成「${course.title}」全部课程与必交作业`,
    height - 333,
    15,
    regular,
    width,
    certificateInk,
  );
  drawCentered(
    page,
    `共 ${String(course.lessons.length)} 节课程 · ${String(
      course.lessons.filter((lesson) => lesson.assignment !== null)
        .length,
    )} 项必交作业`,
    height - 365,
    11,
    regular,
    width,
    certificateInk,
  );
  page.drawLine({
    start: { x: 280, y: height - 400 },
    end: { x: width - 280, y: height - 400 },
    thickness: 1,
    color: rgb(0.08, 0.08, 0.07),
  });
  page.drawText(`签发日期 ${formatIssuedDate(issuedDate)}`, {
    x: 70,
    y: 74,
    size: 9,
    font: regular,
    color: rgb(0.29, 0.29, 0.26),
  });
  page.drawText(`证书编号 ${certificateId}`, {
    x: width - 70 - regular.widthOfTextAtSize(`证书编号 ${certificateId}`, 9),
    y: 74,
    size: 9,
    font: regular,
    color: rgb(0.29, 0.29, 0.26),
  });

  const bytes = await document.save({ useObjectStreams: false });
  const pdfBytes = new Uint8Array(bytes.byteLength);
  pdfBytes.set(bytes);
  return Object.freeze({
    blob: new Blob([pdfBytes.buffer], { type: 'application/pdf' }),
    fileName: `${safeFileName(learnerName)}-${safeFileName(course.title)}-结课证书.pdf`,
    certificateId,
  });
}

function drawCentered(
  page: PDFPage,
  text: string,
  y: number,
  size: number,
  font: PDFFont,
  pageWidth: number,
  color: RGB,
): void {
  const textWidth = font.widthOfTextAtSize(text, size);
  page.drawText(text, {
    x: (pageWidth - textWidth) / 2,
    y,
    size,
    font,
    color,
  });
}

export function courseCertificateId(
  enrollmentId: string,
  courseId: string,
  issuedAt: string,
): string {
  const input = `${enrollmentId}:${courseId}:${issuedAt}`;
  let hash = 2_166_136_261;
  for (const character of input) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619);
  }
  return `ZC-${new Date(issuedAt).getUTCFullYear()}-${(
    hash >>> 0
  )
    .toString(16)
    .padStart(8, '0')
    .toUpperCase()}`;
}

function formatIssuedDate(value: Date): string {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'UTC',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(value);
}

function safeFileName(value: string): string {
  return (
    [...value]
      .map((character) =>
        (character.codePointAt(0) ?? 0) < 32 ? '-' : character,
      )
      .join('')
      .trim()
      .replace(/[<>:"/\\|?*]/gu, '-')
      .replace(/\s+/gu, '-')
      .replace(/-+/gu, '-')
      .replace(/^[.\s-]+|[.\s-]+$/gu, '')
      .slice(0, 60) || 'certificate'
  );
}
