/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { localOcrAssetPaths } from './browser-tesseract-ocr.js';

const viteConfig = readFileSync(
  new URL('../../vite.config.ts', import.meta.url),
  'utf8',
);

describe('browser Tesseract packaging', () => {
  it('uses only application-hosted worker, core and language paths', () => {
    const paths = localOcrAssetPaths();

    expect(paths.workerPath).toMatch(/\/ocr\/worker\.min\.js$/u);
    expect(paths.corePath).toMatch(/\/ocr\/core$/u);
    expect(paths.langPath).toMatch(/\/ocr\/lang$/u);
    expect(JSON.stringify(paths)).not.toMatch(/https?:\/\//u);
  });

  it('emits the worker, compatible cores and both locked language files', () => {
    expect(viteConfig).toContain('tesseract.js/dist/worker.min.js');
    expect(viteConfig).toContain('tesseract-core-lstm.wasm.js');
    expect(viteConfig).toContain('tesseract-core-simd-lstm.wasm.js');
    expect(viteConfig).toContain(
      'tesseract-core-relaxedsimd-lstm.wasm.js',
    );
    expect(viteConfig).toContain('chi_sim.traineddata.gz');
    expect(viteConfig).toContain('eng.traineddata.gz');
  });
});
