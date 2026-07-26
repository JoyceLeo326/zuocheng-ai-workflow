import { describe, expect, it } from 'vitest';
import { IdentityApiError } from './identity-client.js';
import {
  identityErrorMessage,
  parseIdentityLink,
  sanitizedIdentityUrl,
} from './identity-portal.js';

describe('identity portal link and error boundary', () => {
  it('captures recovery and deletion proofs for in-memory use and removes them from the URL', () => {
    const link = parseIdentityLink(
      'https://zuocheng.example/account/security?recoveryToken=recovery-secret&deletionRequestId=01900000-0000-7000-8000-000000000009&confirmationToken=delete-secret&utm_source=email',
    );

    expect(link).toEqual({
      recoveryToken: 'recovery-secret',
      deletionRequestId: '01900000-0000-7000-8000-000000000009',
      confirmationToken: 'delete-secret',
      verificationCompleted: false,
    });
    expect(
      sanitizedIdentityUrl(
        'https://zuocheng.example/account/security?recoveryToken=recovery-secret&deletionRequestId=01900000-0000-7000-8000-000000000009&confirmationToken=delete-secret&utm_source=email',
      ),
    ).toBe('/account/security?utm_source=email');
  });

  it('maps rate, offline and provider failures to actionable non-enumerating copy', () => {
    const response = new Response(null, {
      status: 429,
      headers: { 'Retry-After': '60' },
    });
    const error = new IdentityApiError(
      response,
      { code: 'RATE_LIMITED', detail: 'Internal detail' },
      60,
    );

    expect(identityErrorMessage(error)).toContain('60 秒');
    expect(
      identityErrorMessage(
        new IdentityApiError(
          new Response(null, { status: 503 }),
          { code: 'EMAIL_PROVIDER_UNAVAILABLE' },
          undefined,
        ),
      ),
    ).toContain('邮件服务');
    expect(identityErrorMessage(new TypeError('Failed to fetch'))).toContain(
      '网络',
    );
    expect(
      identityErrorMessage(
        new IdentityApiError(
          new Response(null, { status: 404 }),
          {},
          undefined,
        ),
      ),
    ).toContain('身份 API');
    expect(identityErrorMessage(error)).not.toContain('Internal detail');
  });
});
