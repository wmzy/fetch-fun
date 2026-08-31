import { resolve } from 'path';

import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    reportCompressedSize: true,
    lib: {
      // Two entries share one build so rollup emits the shared config
      // helpers as a single chunk: fetch-fun and fetch-fun/openapi then
      // reference the SAME module-level symbols (readDataSymbol etc.) —
      // self-contained per-entry bundles would duplicate them and break
      // cross-entry pipes (data reader set via openapi, consumed via main).
      entry: {
        index: resolve(__dirname, 'src/index.ts'),
        openapi: resolve(__dirname, 'src/openapi.ts'),
      },
      name: 'fetch-fun',
      formats: ['es', 'cjs'],
      // Use real ESM/CJS extensions so Node resolves each bundle with the
      // correct module kind (a ".js" ESM file would masquerade as CJS).
      fileName: (format, entryName) =>
        `${entryName}.${format === 'es' ? 'mjs' : 'cjs'}`,
    },
    sourcemap: true,
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
});
