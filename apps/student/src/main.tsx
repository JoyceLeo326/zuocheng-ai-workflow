import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createIdentityClient } from './identity/identity-client.js';
import { IdentityPortal } from './identity/identity-portal.js';
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

createRoot(root).render(
  <StrictMode>
    <a className="skip-link" href="#main-content">
      跳到主要内容
    </a>
    <IdentityPortal client={identityClient} />
  </StrictMode>,
);
