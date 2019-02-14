import babel from 'rollup-plugin-babel';
import pkg from './package.json';

export default [
  {
    input: 'src/index.js',
    external: ['lodash/curry'],
    output: {
      globals: {
        'lodash/curry': '_.curry',
      },
      name: pkg.name,
      file: pkg.browser,
      format: 'umd',
    },
    plugins: [
      babel({
        exclude: 'node_modules/**',
      }),
    ],
  },
  {
    input: 'src/index.js',
    external: ['lodash/curry'],
    output: [
      { file: pkg.main, format: 'cjs' },
      { file: pkg.module, format: 'es' },
    ],
  },
];
