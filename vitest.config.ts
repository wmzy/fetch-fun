import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config';

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      include: ['test/**/*.ts'],
      exclude: ['test/setup.ts'],
      setupFiles: ['./test/setup.ts'],
      // ...
    },
  })
);
