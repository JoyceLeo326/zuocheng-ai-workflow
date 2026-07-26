import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AdminApp } from './admin-app.js';
import {
  AdminService,
  createBrowserAdminRepository,
  createBrowserAdminRuntime,
} from './admin-service.js';
import './styles.css';

const root = document.querySelector('#root');
if (root === null) {
  throw new Error('Admin application root is missing');
}

const runtime = createBrowserAdminRuntime();
const service = new AdminService(createBrowserAdminRepository(runtime), runtime);

createRoot(root).render(
  <StrictMode>
    <AdminApp service={service} />
  </StrictMode>,
);
