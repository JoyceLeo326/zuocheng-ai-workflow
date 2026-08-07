import { readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const blockedRuntimeHost = /cdn\.jsdelivr\.net/iu;
const bundledWorkerFallback = 'https://cdn.jsdelivr.net/npm/tesseract.js@v${n}/dist/worker.min.js';
const bundledLanguageFallback = '"https://cdn.jsdelivr.net/npm/@tesseract.js-data/".concat(i,m?"/4.0.0_best_int":"/4.0.0")';
const bundledCoreFallback = '"https://cdn.jsdelivr.net/npm/tesseract.js-core@v".concat(h.substring(1))';

async function filesBelow(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesBelow(target));
    else files.push(target);
  }
  return files;
}

function replaceExactlyOnce(source, needle, replacement, label) {
  const occurrences = source.split(needle).length - 1;
  if (occurrences !== 1) {
    throw new Error(`${label} expected exactly one bundled remote fallback, found ${occurrences}.`);
  }
  return source.replace(needle, replacement);
}

export async function localizeTesseractRuntime(outputRoot, {
  workerPath,
  corePath,
  langPath,
}) {
  const applicationRoot = resolve(outputRoot, 'app');
  const files = await filesBelow(applicationRoot);
  const javascriptFiles = files.filter((file) => /\.(?:js|mjs)$/iu.test(file));
  const workerFile = resolve(applicationRoot, 'ocr', 'worker.min.js');
  let mainBundleMatches = 0;

  for (const file of javascriptFiles) {
    let source = await readFile(file, 'utf8');
    if (source.includes(bundledWorkerFallback)) {
      source = replaceExactlyOnce(source, bundledWorkerFallback, workerPath, 'Tesseract worker');
      await writeFile(file, source, 'utf8');
      mainBundleMatches += 1;
    }
  }
  if (mainBundleMatches !== 1) {
    throw new Error(`Expected one application bundle with the Tesseract worker fallback, found ${mainBundleMatches}.`);
  }

  let workerSource = await readFile(workerFile, 'utf8');
  workerSource = replaceExactlyOnce(workerSource, bundledLanguageFallback, JSON.stringify(langPath), 'Tesseract language data');
  workerSource = replaceExactlyOnce(workerSource, bundledCoreFallback, JSON.stringify(corePath), 'Tesseract core');
  await writeFile(workerFile, workerSource, 'utf8');

  for (const file of files) {
    if (!/\.(?:css|html|js|mjs)$/iu.test(file)) continue;
    const source = await readFile(file, 'utf8');
    if (blockedRuntimeHost.test(source)) {
      throw new Error(`Blocked remote runtime host remains in ${file}.`);
    }
  }
}
