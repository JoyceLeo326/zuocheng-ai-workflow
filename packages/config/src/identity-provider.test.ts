import { describe, expect, it } from 'vitest';
import {
  IdentityProviderConfigurationError,
  parseIdentityProviderConfiguration,
} from './identity-provider.js';

const validConfiguration = {
  baseURL: 'https://api.example.edu',
  trustedOrigins: [
    'https://api.example.edu',
    'https://student.example.edu',
    'https://admin.example.edu',
  ],
  passkey: {
    rpId: 'example.edu',
    rpName: '做成',
  },
};

describe('customer identity provider public configuration', () => {
  it('accepts only explicit HTTPS origins bound to the passkey relying party', () => {
    expect(parseIdentityProviderConfiguration(validConfiguration)).toEqual(
      validConfiguration,
    );
  });

  it.each([
    {
      reason: 'an insecure base URL',
      configuration: {
        ...validConfiguration,
        baseURL: 'http://api.example.edu',
      },
    },
    {
      reason: 'localhost',
      configuration: {
        ...validConfiguration,
        baseURL: 'https://localhost',
        trustedOrigins: ['https://localhost'],
        passkey: { rpId: 'localhost', rpName: '做成' },
      },
    },
    {
      reason: 'a wildcard origin',
      configuration: {
        ...validConfiguration,
        trustedOrigins: [
          'https://api.example.edu',
          'https://*.example.edu',
        ],
      },
    },
    {
      reason: 'an origin with a path',
      configuration: {
        ...validConfiguration,
        trustedOrigins: [
          'https://api.example.edu',
          'https://student.example.edu/login',
        ],
      },
    },
    {
      reason: 'a base URL missing from trusted origins',
      configuration: {
        ...validConfiguration,
        trustedOrigins: ['https://student.example.edu'],
      },
    },
    {
      reason: 'a relying party outside the base URL domain',
      configuration: {
        ...validConfiguration,
        passkey: { rpId: 'other.example', rpName: '做成' },
      },
    },
  ])('rejects $reason before runtime assembly', ({ configuration }) => {
    expect(() =>
      parseIdentityProviderConfiguration(configuration),
    ).toThrow(IdentityProviderConfigurationError);
  });

  it('does not accept OAuth or SMTP secrets in public configuration', () => {
    expect(() =>
      parseIdentityProviderConfiguration({
        ...validConfiguration,
        googleClientSecret: 'must-stay-in-customer-adapter',
      }),
    ).toThrow(IdentityProviderConfigurationError);
  });
});
