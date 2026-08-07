import {
  cp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { stdout } from 'node:process';
import { fileURLToPath } from 'node:url';
import { localizeTesseractRuntime } from './localize-tesseract-runtime.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(root, 'dist', 'mirror');

await rm(output, { force: true, recursive: true });
await mkdir(output, { recursive: true });
await cp(resolve(root, 'apps/marketing/dist'), output, { recursive: true });
await cp(resolve(root, 'apps/student/dist'), resolve(output, 'app'), {
  recursive: true,
});
await cp(resolve(root, 'apps/admin/dist'), resolve(output, 'admin'), {
  recursive: true,
});

const indexPath = resolve(output, 'index.html');
const index = (await readFile(indexPath, 'utf8'))
  .replaceAll('href="/app/', 'href="./app/')
  .replaceAll('href="/admin/', 'href="./admin/');
await writeFile(indexPath, index, 'utf8');
await writeFile(resolve(output, '404.html'), index, 'utf8');
await writeFile(resolve(output, '.nojekyll'), '', 'utf8');

await localizeTesseractRuntime(output, {
  workerPath: './ocr/worker.min.js',
  corePath: './ocr/core',
  langPath: './ocr/lang',
  workerRuntimeCorePath: './core',
  workerRuntimeLangPath: './lang',
});

const emittedFiles = [];
async function collectFiles(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      await collectFiles(absolute);
    } else {
      emittedFiles.push(absolute);
    }
  }
}

await collectFiles(output);
for (const file of emittedFiles.filter((candidate) =>
  /\.(?:html|css|js)$/iu.test(candidate),
)) {
  const source = await readFile(file, 'utf8');
  if (
    /https?:\/\/(?:cdn\.jsdelivr\.net|unpkg\.com|fonts\.googleapis\.com|fonts\.gstatic\.com)/iu.test(
      source,
    )
  ) {
    throw new Error(`Portable mirror contains a blocked runtime host: ${file}`);
  }
}

stdout.write('Portable nested mirror assembled at dist/mirror.\n');
