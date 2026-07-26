import { StrictMode, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createBYOKCredentialStore } from './ai/byok-credential-store.js';
import {
  OPENAI_COMPATIBLE_DISPLAY_NAME,
  OPENAI_COMPATIBLE_PROVIDER_ID,
  createOpenAICompatibleConfigStore,
  testOpenAICompatibleConnection,
} from './ai/openai-compatible-connection.js';
import { createOpenAICompatibleProvider } from './ai/openai-compatible-provider.js';
import { WorkflowAssistant } from './ai/workflow-assistant.js';
import { createIndexedDbWorkflowAssistantStore } from './ai/workflow-assistant-store.js';
import {
  OcrAcquisitionService,
  PdfJsRasterizer,
  UrlAcquisitionService,
  createBrowserTesseractOcrWorker,
} from './acquisition/index.js';
import {
  createIndexedDbProductEventLedger,
  createProductEventRecorder,
  decorateCourseStoreWithAnalytics,
  decorateWorkbenchServiceWithAnalytics,
  resolveAnonymousBrowserId,
} from './analytics/index.js';
import { createIndexedDbCourseStore } from './course/index.js';
import { createIdentityClient } from './identity/identity-client.js';
import { IdentityPortal } from './identity/identity-portal.js';
import type { AuthenticationMode } from './identity/identity-views.js';
import {
  GitHubGistSyncAdapter,
  SyncController,
  createGitHubSyncCredentialStore,
  createIndexedDbSyncStore,
} from './sync/index.js';
import {
  WorkbenchShell,
  studentSurfaceForPath,
} from './workbench/workbench-shell.js';
import {
  deserializeProjectPackage,
  serializeProjectPackage,
} from './workbench/project-manager-controller.js';
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
const projectStore = createIndexedDbProjectStore();
const baseWorkbenchService = createWorkbenchService({
  store: projectStore,
});
const activityLedger = createIndexedDbProductEventLedger();
const productEventRecorder = createProductEventRecorder({
  ledger: activityLedger,
  context: {
    anonymousId: resolveAnonymousBrowserId(),
    sourceVersion: '0.1.0',
  },
});
const workbenchService = decorateWorkbenchServiceWithAnalytics(
  baseWorkbenchService,
  productEventRecorder,
  {
    onAnalyticsError: () => undefined,
  },
);
const byokCredentialStore = createBYOKCredentialStore();
const openAICompatibleConfigStore =
  createOpenAICompatibleConfigStore();
const workflowAssistantStore =
  createIndexedDbWorkflowAssistantStore();
const courseStore = decorateCourseStoreWithAnalytics(
  createIndexedDbCourseStore(),
  productEventRecorder,
  {
    onAnalyticsError: () => undefined,
  },
);
const acquisitionServices = Object.freeze({
  ocrService: new OcrAcquisitionService({
    createWorker: createBrowserTesseractOcrWorker,
    pdfRasterizer: new PdfJsRasterizer(),
  }),
  urlService: new UrlAcquisitionService(),
});
const syncController = new SyncController({
  adapter: new GitHubGistSyncAdapter(),
  store: createIndexedDbSyncStore(),
  credentials: createGitHubSyncCredentialStore(),
  getLocalProject: async (projectId) => {
    const project = await projectStore.getProject(projectId);
    if (project === null) {
      return null;
    }
    const bundle = await baseWorkbenchService.exportProjectBundle(
      projectId,
    );
    return {
      projectId: project.id,
      projectTitle: project.title,
      projectVersion: project.version,
      projectUpdatedAt: project.updatedAt,
      package: await serializeProjectPackage(bundle),
    };
  },
  applyRemoteProject: async ({ projectId, package: file, mode }) => {
    const bundle = await deserializeProjectPackage(file);
    if (bundle.project.id !== projectId) {
      throw new Error('同步项目标识与项目包不一致。');
    }
    if (mode === 'create') {
      await projectStore.importProject(bundle);
      return;
    }
    const current = await projectStore.getProject(projectId);
    if (current === null) {
      throw new Error('此设备上的项目已不存在，请刷新后重试。');
    }
    await projectStore.replaceProject(bundle, current.version);
  },
});

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
const initialSearchParams = new URLSearchParams(
  window.location.search,
);
const requestedAccountMode =
  initialSearchParams.get('account') === 'register'
    ? 'register'
    : initialSearchParams.get('account') === 'login'
      ? 'login'
      : null;
const requestedWorkbenchView =
  initialSearchParams.get('view') === 'courses'
    ? 'courses'
    : initialSearchParams.get('view') === 'templates'
      ? 'templates'
      : initialSearchParams.get('view') === 'sync'
      ? 'sync'
      : initialSearchParams.get('view') === 'assistant'
        ? 'assistant'
        : initialSearchParams.get('view') === 'acquisition'
          ? 'acquisition'
          : initialSearchParams.get('view') === 'activity'
            ? 'activity'
        : initialSearchParams.get('view') === 'projects'
          ? 'projects'
          : 'workbench';

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
    surface === 'identity' ? 'login' : requestedAccountMode,
  );
  const [openAICompatibleConfig, setOpenAICompatibleConfig] =
    useState(() => openAICompatibleConfigStore.load());
  const workflowAssistant = useMemo(() => {
    if (openAICompatibleConfig === null) {
      return undefined;
    }
    return new WorkflowAssistant({
      provider: createOpenAICompatibleProvider({
        id: OPENAI_COMPATIBLE_PROVIDER_ID,
        displayName: OPENAI_COMPATIBLE_DISPLAY_NAME,
        endpoint: openAICompatibleConfig.endpoint,
        model: openAICompatibleConfig.model,
        credentials: byokCredentialStore,
      }),
      store: workflowAssistantStore,
    });
  }, [openAICompatibleConfig]);

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
      acquisition={acquisitionServices}
      activityLedger={activityLedger}
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
      initialView={requestedWorkbenchView}
      onLogin={() => {
        setAccountMode('login');
      }}
      onRegister={() => {
        setAccountMode('register');
      }}
      service={workbenchService}
      syncCenter={{
        controller: syncController,
        online,
      }}
      workflowAssistant={workflowAssistant}
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
