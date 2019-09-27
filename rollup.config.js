import babel from 'rollup-plugin-babel';
import {terser} from 'rollup-plugin-terser';
import plugins, {file} from 'rollup-plugin-by-output';
import pkg from './package.json';

const banner = `
/*!
  * ${pkg.name} v${pkg.version} (${pkg.homepage})
  * Copyright (c) 2019-present ${pkg.author}
  * Licensed under ${pkg.license} (${pkg.homepage}/blob/master/LICENSE)
  */
`;

export default {
  input: 'src/index.js',
  plugins: plugins(
    babel({
      exclude: ['node_modules/**']
    }),
    [file(/\.min\.js$/), terser({sourcemap: true, output: {comments: /^!/}})]
  ),
  output: [
    // browser-friendly UMD build
    {
      name: pkg.name,
      file: pkg.browser,
      exports: 'named',
      sourcemap: true,
      format: 'umd'
    },
    {
      name: pkg.name,
      banner,
      file: pkg.unpkg,
      exports: 'named',
      sourcemap: true,
      format: 'umd'
    },
    {
      file: pkg.main,
      sourcemap: true,
      exports: 'named',
      format: 'cjs'
    },
    {
      file: pkg.module,
      sourcemap: true,
      exports: 'named',
      format: 'es'
    }
  ]
};
