import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createBYOKCredentialStore } from './ai/byok-credential-store.js';
import {
  OPENAI_COMPATIBLE_DISPLAY_NAME,
  OPENAI_COMPATIBLE_PROVIDER_ID,
  createOpenAICompatibleConfigStore,
  testOpenAICompatibleConnection,
} from './ai/openai-compatible-connection.js';
import { createIndexedDbCourseStore } from './course/index.js';
import { createIdentityClient } from './identity/identity-client.js';
import { IdentityPortal } from './identity/identity-portal.js';
import type { AuthenticationMode } from './identity/identity-views.js';
import {
  WorkbenchShell,
  studentSurfaceForPath,
} from './workbench/workbench-shell.js';
import { createWorkbenchService } from './workbench/workbench-service.js';
import { createIndexedDbProjectStore } from './workbench/project-store.js';
import { registerOfflineSupport } from './offline.js';
import './styles.css';

const root = document.querySelector('#root');
if (root === null) {
  throw new Error('Student application root is missing');
}

const configuredApiOrigin = import.meta.env.VITE_API_ORIGIN;
const identityClient = createIdentityClient({
  apiOrigin:
    configuredApiOrigin === undefined || configuredApiOrigin.trim().length === 0
      ? window.location.origin
      : configuredApiOrigin,
});
const workbenchService = createWorkbenchService({
  store: createIndexedDbProjectStore(),
});
const byokCredentialStore = createBYOKCredentialStore();
const openAICompatibleConfigStore =
  createOpenAICompatibleConfigStore();
const courseStore = createIndexedDbCourseStore();

function persistentBrowserId(storageKey: string): string {
  try {
    const existing = window.localStorage
      .getItem(storageKey)
      ?.trim();
    if (existing !== undefined && existing.length > 0) {
      return existing;
    }
    const created = window.crypto.randomUUID();
    window.localStorage.setItem(storageKey, created);
    return created;
  } catch {
    return `browser-profile:${storageKey}`;
  }
}

const courseLearnerId = persistentBrowserId(
  'zuocheng.course.learner-id',
);
const courseEnrollmentId = `zuocheng-7-day:${courseLearnerId}`;

function useOnlineStatus(): boolean {
  const [online, setOnline] = useState(window.navigator.onLine);
  useEffect(() => {
    const refresh = () => setOnline(window.navigator.onLine);
    window.addEventListener('online', refresh);
    window.addEventListener('offline', refresh);
    return () => {
      window.removeEventListener('online', refresh);
      window.removeEventListener('offline', refresh);
    };
  }, []);
  return online;
}

function StudentApplication() {
  const surface = studentSurfaceForPath(window.location.pathname);
  const online = useOnlineStatus();
  const [accountMode, setAccountMode] = useState<AuthenticationMode | null>(
    surface === 'identity' ? 'login' : null,
  );
  const [openAICompatibleConfig, setOpenAICompatibleConfig] =
    useState(() => openAICompatibleConfigStore.load());

  if (surface === 'identity') {
    return <IdentityPortal client={identityClient} />;
  }
  if (accountMode !== null) {
    return (
      <IdentityPortal
        client={identityClient}
        initialMode={accountMode}
        onExit={() => {
          setAccountMode(null);
        }}
      />
    );
  }
  return (
    <WorkbenchShell
      aiSettings={{
        providerId: OPENAI_COMPATIBLE_PROVIDER_ID,
        displayName: OPENAI_COMPATIBLE_DISPLAY_NAME,
        credentials: byokCredentialStore,
        initialEndpoint: openAICompatibleConfig?.endpoint ?? '',
        initialModel: openAICompatibleConfig?.model ?? '',
        onSaveConfig: (config) => {
          openAICompatibleConfigStore.save(config);
          setOpenAICompatibleConfig(config);
        },
        onDeleteConfig: () => {
          openAICompatibleConfigStore.remove();
          setOpenAICompatibleConfig(null);
        },
        onTestConnection: testOpenAICompatibleConnection,
      }}
      courseCenter={{
        enrollmentId: courseEnrollmentId,
        learnerId: courseLearnerId,
        online,
        store: courseStore,
      }}
      onLogin={() => {
        setAccountMode('login');
      }}
      onRegister={() => {
        setAccountMode('register');
      }}
      service={workbenchService}
    />
  );
}

createRoot(root).render(
  <StrictMode>
    <a className="skip-link" href="#main-content">
      跳到主要内容
    </a>
    <StudentApplication />
  </StrictMode>,
);

if (import.meta.env.PROD) {
  void registerOfflineSupport(
    undefined,
    import.meta.env.BASE_URL,
  );
}
