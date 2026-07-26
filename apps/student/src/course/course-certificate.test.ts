import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import {
  courseCertificateId,
  generateCourseCertificate,
} from './course-certificate.js';
import type { CourseCertificateError } from './course-certificate.js';
import {
  LOCAL_7_DAY_COURSE,
  acceptAssignment,
  bindCourseProject,
  createCourseEnrollment,
  submitAssignment,
  updateLessonProgress,
} from './course-model.js';

const STARTED_AT = '2026-07-27T01:00:00.000Z';

function eligibleEnrollment() {
  let current = createCourseEnrollment({
    id: 'enrollment-certificate-001',
    learnerId: 'learner-certificate-001',
    course: LOCAL_7_DAY_COURSE,
    timestamp: STARTED_AT,
  });
  let sequence = 1;
  const timestamp = () =>
    new Date(Date.parse(STARTED_AT) + sequence++ * 1_000).toISOString();
  current = bindCourseProject(
    current,
    'project-certificate-001',
    timestamp(),
  );
  for (const lesson of LOCAL_7_DAY_COURSE.lessons) {
    current = updateLessonProgress(
      current,
      lesson.id,
      'completed',
      timestamp(),
    );
    if (lesson.assignment !== null) {
      const submissionId = `submission-${lesson.id}`;
      current = submitAssignment(current, {
        id: submissionId,
        lessonId: lesson.id,
        content: `${lesson.title}的交付内容`,
        timestamp: timestamp(),
      });
      current = acceptAssignment(current, {
        submissionId,
        reviewerRole: 'mentor',
        timestamp: timestamp(),
      });
    }
  }
  return current;
}

describe('course certificate', () => {
  it('refuses issuance until the persisted course outcome is eligible', async () => {
    const enrollment = createCourseEnrollment({
      id: 'enrollment-incomplete-001',
      learnerId: 'learner-incomplete-001',
      course: LOCAL_7_DAY_COURSE,
      timestamp: STARTED_AT,
    });

    await expect(
      generateCourseCertificate({
        learnerName: '周同学',
        enrollment,
        issuedAt: '2026-08-03T08:00:00.000Z',
      }),
    ).rejects.toMatchObject({
      code: 'NOT_ELIGIBLE',
    } satisfies Partial<CourseCertificateError>);
  });

  it(
    'generates a readable PDF with stable certificate identity and a safe name',
    async () => {
      const first = await generateCourseCertificate({
        learnerName: '周/同学',
        enrollment: eligibleEnrollment(),
        issuedAt: '2026-08-03T08:00:00.000Z',
      });
      expect(first.certificateId).toBe(
        courseCertificateId(
          'enrollment-certificate-001',
          LOCAL_7_DAY_COURSE.id,
          '2026-08-03T08:00:00.000Z',
        ),
      );
      expect(first.certificateId).toMatch(
        /^ZC-2026-[0-9A-F]{8}$/u,
      );
      expect(first.fileName).toBe(
        '周-同学-7-天做成一份可信作品-结课证书.pdf',
      );
      expect(first.blob.type).toBe('application/pdf');
      const bytes = new Uint8Array(
        await first.blob.arrayBuffer(),
      );
      expect(
        new TextDecoder().decode(bytes.slice(0, 8)),
      ).toContain('%PDF-');
      const document = await PDFDocument.load(bytes);
      expect(document.getPageCount()).toBe(1);
      expect(document.getTitle()).toContain('结课证书');
      expect(document.getSubject()).toContain(
        'enrollment-certificate-001',
      );
    },
    15_000,
  );
});
