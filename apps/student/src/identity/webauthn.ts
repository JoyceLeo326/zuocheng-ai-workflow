interface JsonCredentialDescriptor {
  id: string;
  type: PublicKeyCredentialType;
  transports?: AuthenticatorTransport[];
}

export interface JsonCreationOptions {
  challenge: string;
  rp: PublicKeyCredentialRpEntity;
  user: Omit<PublicKeyCredentialUserEntity, 'id'> & { id: string };
  pubKeyCredParams: PublicKeyCredentialParameters[];
  timeout?: number;
  excludeCredentials?: JsonCredentialDescriptor[];
  authenticatorSelection?: AuthenticatorSelectionCriteria;
  attestation?: AttestationConveyancePreference;
  extensions?: AuthenticationExtensionsClientInputs;
}

export interface JsonRequestOptions {
  challenge: string;
  timeout?: number;
  rpId?: string;
  allowCredentials?: JsonCredentialDescriptor[];
  userVerification?: UserVerificationRequirement;
  extensions?: AuthenticationExtensionsClientInputs;
}

function bytesToArrayBuffer(bytes: Uint8Array) {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

export function decodeBase64Url(value: string) {
  if (
    value.length === 0 ||
    !/^[A-Za-z0-9_-]+={0,2}$/.test(value) ||
    value.length % 4 === 1
  ) {
    throw new Error('Invalid base64url value.');
  }
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    throw new Error('Invalid base64url value.');
  }
  const bytes = Uint8Array.from(binary, (character) =>
    character.charCodeAt(0),
  );
  return bytesToArrayBuffer(bytes);
}

export function encodeBase64Url(value: ArrayBuffer) {
  const bytes = new Uint8Array(value);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function decodeDescriptors(descriptors: JsonCredentialDescriptor[]) {
  return descriptors.map((descriptor) => ({
    id: decodeBase64Url(descriptor.id),
    type: descriptor.type,
    ...(descriptor.transports === undefined
      ? {}
      : { transports: descriptor.transports }),
  }));
}

export function decodeCreationOptions(
  options: JsonCreationOptions,
): PublicKeyCredentialCreationOptions {
  return {
    challenge: decodeBase64Url(options.challenge),
    rp: options.rp,
    user: {
      ...options.user,
      id: decodeBase64Url(options.user.id),
    },
    pubKeyCredParams: options.pubKeyCredParams,
    ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
    ...(options.excludeCredentials === undefined
      ? {}
      : {
          excludeCredentials: decodeDescriptors(options.excludeCredentials),
        }),
    ...(options.authenticatorSelection === undefined
      ? {}
      : { authenticatorSelection: options.authenticatorSelection }),
    ...(options.attestation === undefined
      ? {}
      : { attestation: options.attestation }),
    ...(options.extensions === undefined
      ? {}
      : { extensions: options.extensions }),
  };
}

export function decodeRequestOptions(
  options: JsonRequestOptions,
): PublicKeyCredentialRequestOptions {
  return {
    challenge: decodeBase64Url(options.challenge),
    ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
    ...(options.rpId === undefined ? {} : { rpId: options.rpId }),
    ...(options.allowCredentials === undefined
      ? {}
      : { allowCredentials: decodeDescriptors(options.allowCredentials) }),
    ...(options.userVerification === undefined
      ? {}
      : { userVerification: options.userVerification }),
    ...(options.extensions === undefined
      ? {}
      : { extensions: options.extensions }),
  };
}

function nullableBuffer(value: ArrayBuffer | null) {
  return value === null ? null : encodeBase64Url(value);
}

export function serializePublicKeyCredential(
  credential: PublicKeyCredential,
): Record<string, unknown> {
  const response = credential.response;
  const base = {
    id: credential.id,
    rawId: encodeBase64Url(credential.rawId),
    type: credential.type,
    authenticatorAttachment: credential.authenticatorAttachment,
    clientExtensionResults: credential.getClientExtensionResults(),
  };

  if ('attestationObject' in response) {
    const attestation = response as AuthenticatorAttestationResponse;
    return {
      ...base,
      response: {
        clientDataJSON: encodeBase64Url(attestation.clientDataJSON),
        attestationObject: encodeBase64Url(attestation.attestationObject),
        transports: attestation.getTransports(),
        authenticatorData: encodeBase64Url(attestation.getAuthenticatorData()),
        publicKey: nullableBuffer(attestation.getPublicKey()),
        publicKeyAlgorithm: attestation.getPublicKeyAlgorithm(),
      },
    };
  }

  const assertion = response as AuthenticatorAssertionResponse;
  return {
    ...base,
    response: {
      clientDataJSON: encodeBase64Url(assertion.clientDataJSON),
      authenticatorData: encodeBase64Url(assertion.authenticatorData),
      signature: encodeBase64Url(assertion.signature),
      userHandle: nullableBuffer(assertion.userHandle),
    },
  };
}

function requireCredential(
  credential: Credential | null,
): PublicKeyCredential {
  if (credential === null || credential.type !== 'public-key') {
    throw new Error('The authenticator did not return a public-key credential.');
  }
  return credential as PublicKeyCredential;
}

export async function createPasskeyCredential(
  options: JsonCreationOptions,
  credentials: CredentialsContainer = navigator.credentials,
) {
  const credential = await credentials.create({
    publicKey: decodeCreationOptions(options),
  });
  return serializePublicKeyCredential(requireCredential(credential));
}

export async function getPasskeyCredential(
  options: JsonRequestOptions,
  credentials: CredentialsContainer = navigator.credentials,
) {
  const credential = await credentials.get({
    publicKey: decodeRequestOptions(options),
  });
  return serializePublicKeyCredential(requireCredential(credential));
}
