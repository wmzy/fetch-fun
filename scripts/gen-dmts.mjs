// Generates ESM-flavored copies of the tsc declaration output:
// dist/types/*.d.ts -> dist/types/*.d.mts, with relative imports rewritten
// to explicit ".d.mts" specifiers. tsc emits extensionless relative imports
// ("from './types'"), which do not resolve under node16 ESM resolution, so
// the ".d.mts" tree shipped for the "import" condition (see package.json
// exports) needs extensioned specifiers. Verified by publint --strict and
// @arethetypeswrong/cli.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = 'dist/types';
const files = readdirSync(dir).filter((f) => f.endsWith('.d.ts'));

for (const file of files) {
  const source = readFileSync(join(dir, file), 'utf8').replace(
    /(from\s+')(\.\/[^']+)'/g,
    (match, prefix, specifier) =>
      /\.[a-z]+$/.test(specifier) ? match : `${prefix}${specifier}.d.mts'`,
  );
  writeFileSync(join(dir, file.replace(/\.d\.ts$/, '.d.mts')), source);
}

console.log(`Generated ${files.length} .d.mts files in ${dir}`);
