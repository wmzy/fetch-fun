import base from 'tools-config/eslint';
import tsEslint from 'typescript-eslint';

// tools-config enables type-checked rules (strictTypeChecked) but does not
// enable the parser's project service, which those rules require. This repo's
// code predates that standard (lint never ran with type information before),
// so: enable the project service, then downgrade the type-checked rule set
// via tseslint's disable-type-checked preset until the codebase is brought
// up to the strict standard.
export default [
  ...base,
  {
    files: ['**/*.{ts,tsx,cts,mts}'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  tsEslint.configs.disableTypeChecked,
  {
    files: ['**/*.{js,cjs,mjs,ts,cts,mts}'],
    // This package has no React code. tools-config applies react-hooks
    // rules to all files, which misfires on the exported `use()` config
    // function (flagged as a Hook called outside a component).
    rules: {
      'react-hooks/rules-of-hooks': 'off',
    },
  },
  {
    files: ['**/*.{js,jsx,cjs,mjs,ts,tsx,cts,mts}'],
    // eslint-plugin-import@2.32 is incompatible with ESLint 10: import/order
    // calls sourceCode.getTokenOrCommentAfter, an API removed in ESLint 10.
    // Disable it until tools-config ships a compatible plugin version.
    rules: {
      'import/order': 'off',
    },
  },
  {
    files: ['**/*.{ts,tsx,cts,mts}'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
];
