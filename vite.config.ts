import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  build: {
    reportCompressedSize: true,
    lib: {
      entry: resolve(__dirname, 'src/index.ts'),
      name: 'fetch-fun',
      formats: ['es', 'cjs'],
      // Use real ESM/CJS extensions so Node resolves each bundle with the
      // correct module kind (a ".js" ESM file would masquerade as CJS).
      fileName: (format) => `index.${format === 'es' ? 'mjs' : 'cjs'}`,
    },
    sourcemap: true,
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
});
