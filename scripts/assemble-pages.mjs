import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stdout } from 'node:process';
import { localizeTesseractRuntime } from './localize-tesseract-runtime.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(root, 'dist', 'pages');
const repositoryBase = '/zuocheng-ai-workflow/';

await rm(output, { force: true, recursive: true });
await mkdir(output, { recursive: true });
await cp(resolve(root, 'apps/marketing/dist'), output, { recursive: true });
await cp(resolve(root, 'apps/student/dist'), resolve(output, 'app'), { recursive: true });
await cp(resolve(root, 'apps/admin/dist'), resolve(output, 'admin'), { recursive: true });

const indexPath = resolve(output, 'index.html');
const index = (await readFile(indexPath, 'utf8'))
  .replaceAll('href="/app/', `href="${repositoryBase}app/`)
  .replaceAll('href="/admin/', `href="${repositoryBase}admin/`)
  .replaceAll('https://zuocheng-ai-workflow.vercel.app/', 'https://joyceleo326.github.io/zuocheng-ai-workflow/');
await writeFile(indexPath, index, 'utf8');
await writeFile(resolve(output, '404.html'), index, 'utf8');
await writeFile(resolve(output, '.nojekyll'), '', 'utf8');
await localizeTesseractRuntime(output, {
  workerPath: `${repositoryBase}app/ocr/worker.min.js`,
  corePath: `${repositoryBase}app/ocr/core`,
  langPath: `${repositoryBase}app/ocr/lang`,
});

stdout.write('GitHub Pages bundle assembled at dist/pages.\n');
