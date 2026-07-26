import {
  ProblemDetailsSchema,
  VERSION_CONFLICT_TYPE,
  VersionConflictProblemSchema,
} from '@zuocheng/contracts';
import type {
  FieldError,
  ProblemDetails,
  VersionConflictProblem,
} from '@zuocheng/contracts';
import { IdentityLifecycleError } from '../auth/http/identity-lifecycle-service.js';
import { TenantSessionError } from '../auth/tenant-session.js';
import { ProjectServiceError } from '../projects/project-service.js';
import { HttpPreconditionError } from './preconditions.js';
import { HttpRequestError } from './request-body.js';

type ProblemStatus =
  | 400
  | 401
  | 403
  | 404
  | 409
  | 413
  | 415
  | 422
  | 428
  | 429
  | 500
  | 503;

export type ErrorProblem = {
  status: ProblemStatus;
  body: ProblemDetails | VersionConflictProblem;
  headers?: Readonly<Record<string, string>>;
};

export function mapErrorToProblem(
  error: unknown,
  requestId: string,
): ErrorProblem {
  if (error instanceof HttpPreconditionError) {
    return preconditionProblem(error, requestId);
  }

  if (error instanceof HttpRequestError) {
    return requestProblem(error, requestId);
  }

  if (error instanceof IdentityLifecycleError) {
    return identityLifecycleProblem(error, requestId);
  }

  if (error instanceof TenantSessionError) {
    return tenantSessionProblem(error, requestId);
  }

  if (error instanceof ProjectServiceError) {
    return projectServiceProblem(error, requestId);
  }

  return internalProblem(requestId);
}

function requestProblem(
  error: HttpRequestError,
  requestId: string,
): ErrorProblem {
  switch (error.code) {
    case 'PAYLOAD_TOO_LARGE':
      return baseResult(413, requestId, {
        code: error.code,
        title: 'Payload too large',
        message: 'The request payload exceeds the allowed size',
        retryable: false,
      });
    case 'UNSUPPORTED_MEDIA_TYPE':
      return baseResult(415, requestId, {
        code: error.code,
        title: 'Unsupported media type',
        message: 'A JSON request body is required',
        retryable: false,
      });
    case 'VALIDATION_FAILED':
      return baseResult(422, requestId, {
        code: error.code,
        title: 'Validation failed',
        message: 'The request payload is invalid',
        retryable: false,
      });
  }
}

function tenantSessionProblem(
  error: TenantSessionError,
  requestId: string,
): ErrorProblem {
  switch (error.code) {
    case 'IDENTITY_SERVICE_UNAVAILABLE':
      return baseResult(503, requestId, {
        code: error.code,
        title: 'Identity service unavailable',
        message: 'Identity verification is temporarily unavailable',
        retryable: true,
      });
    case 'AUTH_REQUIRED':
      return baseResult(401, requestId, {
        code: error.code,
        title: 'Authentication required',
        message: 'Authentication is required',
        retryable: false,
      });
    case 'TENANT_MEMBERSHIP_REQUIRED':
      return baseResult(403, requestId, {
        code: error.code,
        title: 'Tenant membership required',
        message: 'An active tenant membership is required',
        retryable: false,
      });
    case 'TENANT_OVERRIDE_FORBIDDEN':
      return baseResult(400, requestId, {
        code: error.code,
        title: 'Tenant override forbidden',
        message: 'Tenant context cannot be supplied by the client',
        retryable: false,
      });
  }
}

export function notFoundProblem(requestId: string): ProblemDetails {
  return parseProblem({
    type: 'https://zuocheng.app/problems/not-found',
    title: 'Not found',
    status: 404,
    code: 'NOT_FOUND',
    message: 'The requested resource does not exist',
    requestId,
    retryable: false,
  });
}

export function projectServiceUnavailableProblem(
  requestId: string,
): ProblemDetails {
  return parseProblem({
    type: 'https://zuocheng.app/problems/project-service-not-configured',
    title: 'Project service not configured',
    status: 503,
    code: 'PROJECT_SERVICE_NOT_CONFIGURED',
    message: 'Project persistence is not configured for this runtime',
    requestId,
    retryable: false,
  });
}

export function identityLifecycleUnavailableProblem(
  requestId: string,
): ProblemDetails {
  return parseProblem({
    type:
      'https://zuocheng.app/problems/identity-lifecycle-not-configured',
    title: 'Identity lifecycle not configured',
    status: 503,
    code: 'IDENTITY_LIFECYCLE_NOT_CONFIGURED',
    message:
      'Identity lifecycle, security, and persistent rate-limit services are not configured for this runtime',
    requestId,
    retryable: false,
  });
}

function identityLifecycleProblem(
  error: IdentityLifecycleError,
  requestId: string,
): ErrorProblem {
  switch (error.code) {
    case 'AUTH_REQUIRED':
      return baseResult(401, requestId, {
        code: error.code,
        title: 'Authentication required',
        message: 'Authentication is required',
        retryable: false,
      });
    case 'INVALID_CREDENTIALS':
      return baseResult(401, requestId, {
        code: error.code,
        title: 'Authentication failed',
        message: 'The supplied credentials could not be verified',
        retryable: false,
      });
    case 'RECENT_AUTH_REQUIRED':
      return baseResult(403, requestId, {
        code: error.code,
        title: 'Recent authentication required',
        message: 'Recent authentication is required for this operation',
        retryable: false,
      });
    case 'ORIGIN_FORBIDDEN':
      return baseResult(403, requestId, {
        code: error.code,
        title: 'Origin forbidden',
        message: 'The request origin is not trusted',
        retryable: false,
      });
    case 'CSRF_FAILED':
      return baseResult(403, requestId, {
        code: error.code,
        title: 'CSRF verification failed',
        message: 'The request could not be verified',
        retryable: false,
      });
    case 'SECURITY_CONTROL_UNAVAILABLE':
      return baseResult(503, requestId, {
        code: error.code,
        title: 'Security control unavailable',
        message: 'Request security verification is temporarily unavailable',
        retryable: true,
      });
    case 'RATE_LIMITED':
      if (
        !Number.isSafeInteger(error.retryAfterSeconds) ||
        (error.retryAfterSeconds as number) < 1 ||
        (error.retryAfterSeconds as number) > 86_400
      ) {
        return baseResult(503, requestId, {
          code: 'RATE_LIMIT_UNAVAILABLE',
          title: 'Rate limit unavailable',
          message:
            'Request rate-limit verification is temporarily unavailable',
          retryable: true,
        });
      }
      return {
        ...baseResult(429, requestId, {
          code: error.code,
          title: 'Too many requests',
          message: 'Too many requests were received',
          retryable: true,
        }),
        headers: {
          'Retry-After': String(error.retryAfterSeconds),
        },
      };
    case 'RATE_LIMIT_UNAVAILABLE':
      return baseResult(503, requestId, {
        code: error.code,
        title: 'Rate limit unavailable',
        message: 'Request rate-limit verification is temporarily unavailable',
        retryable: true,
      });
    case 'OAUTH_PROVIDER_UNAVAILABLE':
      return baseResult(503, requestId, {
        code: error.code,
        title: 'OAuth provider unavailable',
        message: 'The requested OAuth provider is not configured',
        retryable: false,
      });
    case 'EMAIL_PROVIDER_UNAVAILABLE':
      return baseResult(503, requestId, {
        code: error.code,
        title: 'Email provider unavailable',
        message: 'Account email delivery is not configured',
        retryable: false,
      });
    case 'IDENTITY_SERVICE_UNAVAILABLE':
      return baseResult(503, requestId, {
        code: error.code,
        title: 'Identity service unavailable',
        message: 'The identity service is temporarily unavailable',
        retryable: true,
      });
    case 'VERIFICATION_TOKEN_INVALID':
      return baseResult(400, requestId, {
        code: error.code,
        title: 'Verification request invalid',
        message: 'The verification request is invalid or expired',
        retryable: false,
      });
    case 'OAUTH_CALLBACK_INVALID':
      return baseResult(400, requestId, {
        code: error.code,
        title: 'OAuth callback invalid',
        message: 'The OAuth callback could not be verified',
        retryable: false,
      });
    case 'PASSKEY_VERIFICATION_FAILED':
      return baseResult(401, requestId, {
        code: error.code,
        title: 'Passkey verification failed',
        message: 'The passkey assertion could not be verified',
        retryable: false,
      });
    case 'RECOVERY_TOKEN_INVALID':
      return baseResult(400, requestId, {
        code: error.code,
        title: 'Recovery request invalid',
        message: 'The recovery request is invalid or expired',
        retryable: false,
      });
    case 'RESOURCE_NOT_FOUND':
      return baseResult(404, requestId, {
        code: error.code,
        title: 'Resource not found',
        message: 'The requested identity resource does not exist',
        retryable: false,
      });
    case 'IDEMPOTENCY_KEY_REUSED':
      return baseResult(409, requestId, {
        code: error.code,
        title: 'Idempotency key conflict',
        message: 'The idempotency key was already used for another request',
        retryable: false,
      });
    case 'ACCOUNT_DELETION_NOT_CANCELLABLE':
      return baseResult(409, requestId, {
        code: error.code,
        title: 'Account deletion cannot be cancelled',
        message: 'The account deletion request cannot be cancelled',
        retryable: false,
      });
    case 'ACCOUNT_DELETION_ALREADY_IRREVERSIBLE':
      return baseResult(409, requestId, {
        code: error.code,
        title: 'Account deletion is irreversible',
        message: 'The account deletion request has entered its irreversible phase',
        retryable: false,
      });
  }
}

function preconditionProblem(
  error: HttpPreconditionError,
  requestId: string,
): ErrorProblem {
  switch (error.code) {
    case 'PRECONDITION_REQUIRED':
      return baseResult(428, requestId, {
        code: error.code,
        title: 'Precondition required',
        message: 'If-Match is required for this mutation',
        retryable: false,
      });
    case 'IDEMPOTENCY_KEY_REQUIRED':
      return baseResult(428, requestId, {
        code: error.code,
        title: 'Precondition required',
        message: 'Idempotency-Key is required for this mutation',
        retryable: false,
      });
    case 'INVALID_IF_MATCH':
      return baseResult(400, requestId, {
        code: error.code,
        title: 'Invalid request precondition',
        message: 'If-Match must contain one canonical strong version ETag',
        retryable: false,
      });
    case 'INVALID_IDEMPOTENCY_KEY':
      return baseResult(400, requestId, {
        code: error.code,
        title: 'Invalid request precondition',
        message: 'Idempotency-Key must use the supported safe format',
        retryable: false,
      });
  }
}

function projectServiceProblem(
  error: ProjectServiceError,
  requestId: string,
): ErrorProblem {
  switch (error.code) {
    case 'VALIDATION_FAILED': {
      const fieldErrors = safeFieldErrors(error.details);
      return baseResult(422, requestId, {
        code: error.code,
        title: 'Validation failed',
        message: 'The request payload is invalid',
        retryable: false,
        ...(fieldErrors.length === 0 ? {} : { fieldErrors }),
      });
    }
    case 'PROJECT_NOT_FOUND':
      return baseResult(404, requestId, {
        code: error.code,
        title: 'Project not found',
        message: 'The requested project does not exist',
        retryable: false,
      });
    case 'PROJECT_ACCESS_DENIED':
      return baseResult(403, requestId, {
        code: error.code,
        title: 'Project access denied',
        message: 'The current user cannot modify this project',
        retryable: false,
      });
    case 'VERSION_CONFLICT':
      return versionConflictProblem(error, requestId);
    case 'IDEMPOTENCY_KEY_REUSED':
      return baseResult(409, requestId, {
        code: error.code,
        title: 'Idempotency key conflict',
        message: 'The idempotency key was already used for another request',
        retryable: false,
      });
    case 'INVALID_PROJECT_STATE':
      return baseResult(409, requestId, {
        code: error.code,
        title: 'Invalid project state',
        message: 'The project state does not allow this operation',
        retryable: false,
      });
    case 'STORE_INVARIANT_VIOLATION':
    case 'UUID_GENERATOR_NOT_CONFIGURED':
      return internalProblem(requestId);
  }
}

function versionConflictProblem(
  error: ProjectServiceError,
  requestId: string,
): ErrorProblem {
  const details = asRecord(error.details);
  const current = asRecord(details?.current);
  if (details === undefined || current === undefined) {
    return internalProblem(requestId);
  }

  const safeCurrent = safeCurrentProjectSnapshot(current);
  const candidate = {
    type: VERSION_CONFLICT_TYPE,
    title: 'Version conflict' as const,
    status: 409 as const,
    code: 'VERSION_CONFLICT' as const,
    message: 'The project changed after it was loaded',
    requestId,
    retryable: false as const,
    resource: {
      tenantId: safeCurrent.tenantId,
      id: safeCurrent.id,
    },
    expectedVersion: details.expectedVersion,
    currentVersion: safeCurrent.version,
    currentETag: safeCurrent.etag,
    current: safeCurrent,
  };
  const parsed = VersionConflictProblemSchema.safeParse(candidate);
  if (!parsed.success) {
    return internalProblem(requestId);
  }
  return { status: 409, body: parsed.data };
}

function safeCurrentProjectSnapshot(
  current: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const snapshot: Record<string, unknown> = {};
  const publicFields = [
    'tenantId',
    'id',
    'version',
    'etag',
    'name',
    'description',
    'status',
    'deletionStatus',
    'copiedFromProjectId',
    'createdBy',
    'updatedBy',
    'createdAt',
    'updatedAt',
    'archivedAt',
    'deletedAt',
  ] as const;

  for (const field of publicFields) {
    const value = current[field];
    if (
      value === null ||
      typeof value === 'string' ||
      (typeof value === 'number' && Number.isSafeInteger(value))
    ) {
      snapshot[field] = value;
    }
  }
  return snapshot;
}

function safeFieldErrors(
  details: Readonly<Record<string, unknown>> | undefined,
): FieldError[] {
  const issues = asRecord(details)?.issues;
  if (!Array.isArray(issues)) {
    return [];
  }

  const fieldErrors: FieldError[] = [];
  for (const untrustedIssue of issues.slice(0, 100)) {
    const issue = asRecord(untrustedIssue);
    if (issue === undefined) {
      continue;
    }
    const issueCode = safeIssueCode(issue.code);
    fieldErrors.push({
      path: safeIssuePath(issue.path),
      code: `ZOD_${issueCode}`,
      message: safeIssueMessage(issueCode),
    });
  }
  return fieldErrors;
}

function safeIssueCode(value: unknown): string {
  if (typeof value !== 'string') {
    return 'INVALID_VALUE';
  }
  const normalized = value
    .toUpperCase()
    .replace(/[^A-Z0-9]+/gu, '_')
    .replace(/^_+|_+$/gu, '')
    .slice(0, 90);
  return normalized.length === 0 ? 'INVALID_VALUE' : normalized;
}

function safeIssuePath(value: unknown): Array<string | number> {
  if (!Array.isArray(value)) {
    return ['body'];
  }
  const path: Array<string | number> = [];
  for (const segment of value.slice(0, 32)) {
    if (Number.isInteger(segment) && Number(segment) >= 0) {
      path.push(Number(segment));
      continue;
    }
    if (
      typeof segment === 'string' &&
      segment.length > 0 &&
      segment.length <= 128 &&
      !/\p{Cc}/u.test(segment)
    ) {
      path.push(segment);
    }
  }
  return path.length === 0 ? ['body'] : path;
}

function safeIssueMessage(code: string): string {
  switch (code) {
    case 'INVALID_TYPE':
      return 'Value has the wrong type';
    case 'TOO_SMALL':
      return 'Value is below the allowed minimum';
    case 'TOO_BIG':
      return 'Value exceeds the allowed maximum';
    case 'INVALID_FORMAT':
      return 'Value has an invalid format';
    case 'UNRECOGNIZED_KEYS':
      return 'Request contains unsupported fields';
    default:
      return 'Value is invalid';
  }
}

function baseResult(
  status: ProblemStatus,
  requestId: string,
  fields: {
    code: string;
    title: string;
    message: string;
    retryable: boolean;
    fieldErrors?: FieldError[];
  },
): ErrorProblem {
  return {
    status,
    body: parseProblem({
      type: `https://zuocheng.app/problems/${fields.code.toLowerCase().replaceAll('_', '-')}`,
      title: fields.title,
      status,
      code: fields.code,
      message: fields.message,
      requestId,
      retryable: fields.retryable,
      ...(fields.fieldErrors === undefined
        ? {}
        : { fieldErrors: fields.fieldErrors }),
    }),
  };
}

function internalProblem(requestId: string): ErrorProblem {
  return baseResult(500, requestId, {
    code: 'INTERNAL_ERROR',
    title: 'Internal server error',
    message: 'An unexpected error occurred',
    retryable: true,
  });
}

function parseProblem(candidate: unknown): ProblemDetails {
  return ProblemDetailsSchema.parse(candidate);
}

function asRecord(
  value: unknown,
): Readonly<Record<string, unknown>> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return value as Readonly<Record<string, unknown>>;
}
