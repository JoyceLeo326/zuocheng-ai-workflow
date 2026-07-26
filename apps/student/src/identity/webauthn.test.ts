import { describe, expect, it } from 'vitest';
import {
  decodeCreationOptions,
  decodeRequestOptions,
  encodeBase64Url,
  serializePublicKeyCredential,
} from './webauthn.js';

describe('WebAuthn browser boundary', () => {
  it('decodes base64url challenges and credential IDs into ArrayBuffers', () => {
    const creation = decodeCreationOptions({
      challenge: 'AQID',
      rp: { id: 'zuocheng.example', name: '做成■' },
      user: {
        id: 'BAUG',
        name: 'student@example.test',
        displayName: '林同学',
      },
      pubKeyCredParams: [{ alg: -7, type: 'public-key' }],
      excludeCredentials: [{ id: 'BwgJ', type: 'public-key' }],
    });
    const request = decodeRequestOptions({
      challenge: 'CgsM',
      rpId: 'zuocheng.example',
      allowCredentials: [{ id: 'DQ4P', type: 'public-key' }],
    });

    expect(
      Array.from(new Uint8Array(creation.challenge as ArrayBuffer)),
    ).toEqual([1, 2, 3]);
    expect(Array.from(new Uint8Array(creation.user.id as ArrayBuffer))).toEqual([
      4, 5, 6,
    ]);
    expect(
      Array.from(
        new Uint8Array(creation.excludeCredentials?.[0]?.id as ArrayBuffer),
      ),
    ).toEqual([7, 8, 9]);
    expect(
      Array.from(new Uint8Array(request.challenge as ArrayBuffer)),
    ).toEqual([10, 11, 12]);
    expect(
      Array.from(
        new Uint8Array(request.allowCredentials?.[0]?.id as ArrayBuffer),
      ),
    ).toEqual([13, 14, 15]);
  });

  it('serializes an assertion without leaking browser-native objects', () => {
    const credential = {
      id: 'credential-id',
      rawId: Uint8Array.from([1, 2, 3]).buffer,
      type: 'public-key',
      authenticatorAttachment: 'platform',
      getClientExtensionResults: () => ({ credProps: { rk: true } }),
      response: {
        clientDataJSON: Uint8Array.from([4, 5]).buffer,
        authenticatorData: Uint8Array.from([6, 7]).buffer,
        signature: Uint8Array.from([8, 9]).buffer,
        userHandle: Uint8Array.from([10]).buffer,
      },
    } as unknown as PublicKeyCredential;

    expect(serializePublicKeyCredential(credential)).toEqual({
      id: 'credential-id',
      rawId: 'AQID',
      type: 'public-key',
      authenticatorAttachment: 'platform',
      clientExtensionResults: { credProps: { rk: true } },
      response: {
        clientDataJSON: 'BAU',
        authenticatorData: 'Bgc',
        signature: 'CAk',
        userHandle: 'Cg',
      },
    });
    expect(encodeBase64Url(Uint8Array.from([251, 255]).buffer)).toBe('-_8');
  });

  it('rejects malformed base64url before invoking the authenticator', () => {
    expect(() =>
      decodeRequestOptions({
        challenge: '***',
        rpId: 'zuocheng.example',
      }),
    ).toThrow(/base64url/);
  });
});
