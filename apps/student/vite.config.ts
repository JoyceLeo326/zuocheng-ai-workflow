/// <reference types="node" />

import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

const require = createRequire(import.meta.url);
const ocrAssetSources = new Map<string, string>([
  [
    'ocr/worker.min.js',
    require.resolve('tesseract.js/dist/worker.min.js'),
  ],
  [
    'ocr/core/tesseract-core-lstm.wasm.js',
    require.resolve(
      'tesseract.js-core/tesseract-core-lstm.wasm.js',
    ),
  ],
  [
    'ocr/core/tesseract-core-simd-lstm.wasm.js',
    require.resolve(
      'tesseract.js-core/tesseract-core-simd-lstm.wasm.js',
    ),
  ],
  [
    'ocr/core/tesseract-core-relaxedsimd-lstm.wasm.js',
    require.resolve(
      'tesseract.js-core/tesseract-core-relaxedsimd-lstm.wasm.js',
    ),
  ],
  [
    'ocr/lang/chi_sim.traineddata.gz',
    require.resolve(
      '@tesseract.js-data/chi_sim/4.0.0_best_int/chi_sim.traineddata.gz',
    ),
  ],
  [
    'ocr/lang/eng.traineddata.gz',
    require.resolve(
      '@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz',
    ),
  ],
]);

function localOcrAssets(): Plugin {
  return {
    name: 'zuocheng-local-ocr-assets',
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const requestUrl = request.url;
        if (requestUrl === undefined) {
          next();
          return;
        }
        const pathname = new URL(
          requestUrl,
          'http://localhost',
        ).pathname;
        const marker = pathname.lastIndexOf('/ocr/');
        if (marker < 0) {
          next();
          return;
        }
        const assetPath = pathname.slice(marker + 1);
        const source = ocrAssetSources.get(assetPath);
        if (source === undefined) {
          next();
          return;
        }
        try {
          const bytes = await readFile(source);
          response.statusCode = 200;
          response.setHeader(
            'Content-Type',
            assetPath.endsWith('.js')
              ? 'text/javascript; charset=utf-8'
              : 'application/gzip',
          );
          response.setHeader('Cache-Control', 'public, max-age=31536000');
          response.end(bytes);
        } catch {
          response.statusCode = 500;
          response.end('OCR asset unavailable');
        }
      });
    },
    async generateBundle() {
      for (const [fileName, sourcePath] of ocrAssetSources) {
        this.emitFile({
          type: 'asset',
          fileName,
          source: await readFile(sourcePath),
        });
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), localOcrAssets()],
  server: { port: 4174 },
});
