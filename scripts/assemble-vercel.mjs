import { cp, mkdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { stdout } from 'node:process';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
);
const outputRoot = resolve(repositoryRoot, 'dist', 'vercel');
const marketingDist = resolve(
  repositoryRoot,
  'apps',
  'marketing',
  'dist',
);
const studentDist = resolve(
  repositoryRoot,
  'apps',
  'student',
  'dist',
);
const adminDist = resolve(
  repositoryRoot,
  'apps',
  'admin',
  'dist',
);

await rm(outputRoot, { force: true, recursive: true });
await mkdir(outputRoot, { recursive: true });
await cp(marketingDist, outputRoot, { recursive: true });
await cp(studentDist, resolve(outputRoot, 'app'), {
  recursive: true,
});
await cp(adminDist, resolve(outputRoot, 'admin'), {
  recursive: true,
});

stdout.write(
  'Vercel bundle assembled: marketing /, workbench /app/, admin /admin/.\n',
);
