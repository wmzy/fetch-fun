module.exports = {
  env: {
      browser: true,
      worker: true,
      node: true,
      es6: true
  },
  extends: 'airbnb-base',
  parser: 'babel-eslint',
  plugins: ['babel'],
  parserOptions: {
      sourceType: 'module'
  },
  rules: {
      indent: [
          'error',
          2
      ],
      'linebreak-style': [
          'error',
          'unix'
      ],
      quotes: [
          'error',
          'single'
      ],
      semi: [
          'error',
          'always'
      ]
  }
};
