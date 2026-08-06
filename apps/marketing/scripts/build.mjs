import { cp, mkdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { stdout } from 'node:process';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputRoot = resolve(packageRoot, 'dist');

const localFiles = [
  'index.html',
  'styles.css',
  'script.js',
  'planner.js',
  'story.js',
  'assets/brand',
  'assets/story',
  'assets/og-cover.jpg',
  'assets/og-cover.png',
  'assets/og-cover.svg',
  'assets/做成-AI学习工作流.pdf',
];

await rm(outputRoot, { force: true, recursive: true });

for (const relativePath of localFiles) {
  const destination = resolve(outputRoot, relativePath);
  await mkdir(dirname(destination), { recursive: true });
  await cp(resolve(packageRoot, relativePath), destination, { recursive: true });
}

stdout.write(
  `Marketing allowlist build complete (${localFiles.length} files).\n`,
);
