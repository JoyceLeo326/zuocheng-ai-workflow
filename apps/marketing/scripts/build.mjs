import { cp, mkdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { stdout } from 'node:process';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = resolve(packageRoot, '../..');
const outputRoot = resolve(packageRoot, 'dist');

const localFiles = [
  'index.html',
  'styles.css',
  'script.js',
  'planner.js',
  'assets/og-cover.jpg',
  'assets/og-cover.png',
  'assets/og-cover.svg',
  'assets/做成-AI学习工作流.pdf',
];

const publicDocuments = [
  'product-architecture.md',
  'content-system.md',
  'launch-playbook.md',
  'measurement.md',
];

await rm(outputRoot, { force: true, recursive: true });

for (const relativePath of localFiles) {
  const destination = resolve(outputRoot, relativePath);
  await mkdir(dirname(destination), { recursive: true });
  await cp(resolve(packageRoot, relativePath), destination);
}

for (const document of publicDocuments) {
  const destination = resolve(outputRoot, 'docs', document);
  await mkdir(dirname(destination), { recursive: true });
  await cp(resolve(repositoryRoot, 'docs', document), destination);
}

stdout.write(
  `Marketing allowlist build complete (${localFiles.length + publicDocuments.length} files).\n`,
);
