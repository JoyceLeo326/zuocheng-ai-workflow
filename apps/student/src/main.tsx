import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
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

function StudentApplication() {
  const surface = studentSurfaceForPath(window.location.pathname);
  const [accountMode, setAccountMode] = useState<AuthenticationMode | null>(
    surface === 'identity' ? 'login' : null,
  );

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
  void registerOfflineSupport();
}
