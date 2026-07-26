export interface ServiceWorkerRegistrationLike {
  readonly scope: string;
}

export interface ServiceWorkerContainerLike {
  register(
    scriptUrl: string,
    options: { scope: string; updateViaCache: 'none' },
  ): Promise<ServiceWorkerRegistrationLike>;
}

export async function registerOfflineSupport(
  serviceWorker:
    | ServiceWorkerContainerLike
    | null
    | undefined = globalThis.navigator?.serviceWorker,
  baseUrl = '/',
): Promise<ServiceWorkerRegistrationLike | null> {
  if (serviceWorker === null || serviceWorker === undefined) {
    return null;
  }
  const scope =
    baseUrl.startsWith('/') && baseUrl.endsWith('/')
      ? baseUrl
      : '/';
  try {
    return await serviceWorker.register(`${scope}sw.js`, {
      scope,
      updateViaCache: 'none',
    });
  } catch {
    return null;
  }
}
