import { access, readFile, readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { stdout } from 'node:process';
import { fileURLToPath, URL } from 'node:url';

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
);
const outputRoot = resolve(repositoryRoot, 'dist', 'vercel');

const entrypoints = [
  {
    label: 'marketing',
    prefix: '/',
    file: resolve(outputRoot, 'index.html'),
  },
  {
    label: 'workbench',
    prefix: '/app/',
    file: resolve(outputRoot, 'app', 'index.html'),
    requiredFiles: [
      'app/sw.js',
      'app/ocr/worker.min.js',
      'app/ocr/core/tesseract-core-lstm.wasm.js',
      'app/ocr/core/tesseract-core-simd-lstm.wasm.js',
      'app/ocr/core/tesseract-core-relaxedsimd-lstm.wasm.js',
      'app/ocr/lang/chi_sim.traineddata.gz',
      'app/ocr/lang/eng.traineddata.gz',
    ],
  },
  {
    label: 'admin',
    prefix: '/admin/',
    file: resolve(outputRoot, 'admin', 'index.html'),
  },
];

function fail(message) {
  throw new Error(`Vercel bundle verification failed: ${message}`);
}

async function assertNoBlockedRuntimeHosts(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      await assertNoBlockedRuntimeHosts(target);
      continue;
    }
    if (!/\.(?:css|html|js|mjs)$/iu.test(entry.name)) continue;
    const source = await readFile(target, 'utf8');
    if (/fonts\.googleapis\.com|gstatic\.com|unpkg\.com|cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com/iu.test(source)) {
      fail(`blocked remote runtime host found in ${target}`);
    }
  }
}

async function assertFile(file, label) {
  try {
    await access(file);
  } catch {
    fail(`${label} is missing at ${file}`);
  }
}

function assetUrls(html) {
  const urls = [];
  const pattern =
    /<(?:script|link)\b[^>]*\b(?:src|href)=["']([^"'#?]+)(?:[?#][^"']*)?["'][^>]*>/giu;

  for (const match of html.matchAll(pattern)) {
    const url = match[1];
    if (
      url.startsWith('data:') ||
      url.startsWith('http://') ||
      url.startsWith('https://') ||
      url.startsWith('//')
    ) {
      continue;
    }
    urls.push(url);
  }

  return urls;
}

async function verifyEntrypoint({
  label,
  prefix,
  file,
  requiredFiles = [],
}) {
  await assertFile(file, `${label} entrypoint`);
  for (const requiredFile of requiredFiles) {
    await assertFile(
      resolve(outputRoot, requiredFile),
      `${label} runtime asset /${requiredFile}`,
    );
  }
  const html = await readFile(file, 'utf8');
  const urls = assetUrls(html);

  if (urls.length === 0) {
    fail(`${label} entrypoint has no local script or stylesheet assets`);
  }

  for (const url of urls) {
    const publicPath = new URL(
      url,
      `https://bundle.invalid${prefix}`,
    ).pathname;

    if (!publicPath.startsWith(prefix)) {
      fail(
        `${label} asset ${url} does not use its public base ${prefix}`,
      );
    }

    const outputFile = resolve(
      outputRoot,
      publicPath.replace(/^\/+/u, ''),
    );
    await assertFile(outputFile, `${label} asset ${url}`);
  }
}

const vercelConfig = JSON.parse(
  await readFile(resolve(repositoryRoot, 'vercel.json'), 'utf8'),
);

if (vercelConfig.outputDirectory !== 'dist/vercel') {
  fail('vercel.json outputDirectory must be dist/vercel');
}
if (vercelConfig.buildCommand !== 'pnpm build:vercel') {
  fail('vercel.json buildCommand must be pnpm build:vercel');
}
if (vercelConfig.trailingSlash !== true) {
  fail(
    'vercel.json must keep trailingSlash enabled for /app/ and /admin/ entrypoints',
  );
}

for (const entrypoint of entrypoints) {
  await verifyEntrypoint(entrypoint);
}
await assertNoBlockedRuntimeHosts(outputRoot);

stdout.write(
  'Vercel bundle verified: /, /app/, and /admin/ entrypoints and local assets are complete.\n',
);
