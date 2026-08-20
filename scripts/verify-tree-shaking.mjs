#!/usr/bin/env node
/**
 * Tree-shaking verification for fetch-fun.
 *
 * Bundles a minimal consumer entry that imports only `create`, `url`,
 * `fetchJSON` and `json` from src/index.ts, then asserts that the minified
 * bundle carries no code belonging to middleware the entry never uses
 * (withRetry/withTimeout/withAuth/withLogging/withProgress and their
 * retry/backoff helpers).
 *
 * esbuild is resolved from node_modules without adding it as a direct
 * dependency: first via a plain resolve, then through vite's dependency
 * chain, and finally by scanning the pnpm store.
 *
 * Exits non-zero if esbuild fails or any forbidden marker survives.
 */
import { readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Strings that only exist inside middleware/retry code paths. */
const FORBIDDEN_MARKERS = [
  'builtin:progress',
  'builtin:retry',
  'builtin:auth',
  'builtin:logging',
  'Retry-After',
  'backoffDelay',
];

function resolveEsbuild() {
  const candidates = [];
  const rootRequire = createRequire(import.meta.url);

  try {
    candidates.push(rootRequire.resolve('esbuild'));
  } catch {
    /* not hoisted to the project root under pnpm's strict layout */
  }

  try {
    // vite is a direct devDependency and depends on esbuild
    const vitePkg = rootRequire.resolve('vite/package.json');
    candidates.push(createRequire(vitePkg).resolve('esbuild'));
  } catch {
    /* vite not installed */
  }

  try {
    // last resort: any esbuild copy in the pnpm store
    const pnpmDir = resolve(root, 'node_modules/.pnpm');
    const newest = readdirSync(pnpmDir)
      .filter((entry) => /^esbuild@\d/.test(entry))
      .sort()
      .at(-1);
    if (newest) {
      candidates.push(
        createRequire(
          resolve(pnpmDir, newest, 'node_modules/esbuild/package.json'),
        ).resolve('esbuild'),
      );
    }
  } catch {
    /* no .pnpm directory */
  }

  for (const candidate of candidates) {
    try {
      return { module: rootRequire(candidate), from: candidate };
    } catch {
      /* try the next candidate */
    }
  }
  throw new Error(
    'unable to resolve esbuild from node_modules (looked for a direct ' +
      'resolve, a transitive copy via vite, and any copy in node_modules/.pnpm)',
  );
}

async function main() {
  const { module: esbuild, from: esbuildPath } = resolveEsbuild();
  const entry = resolve(root, 'src/index.ts');

  // The console.log reference keeps the imports alive so esbuild cannot
  // shake out everything (same technique size-limit itself uses).
  const result = await esbuild.build({
    stdin: {
      contents:
        `import { create, url, fetchJSON, json } from ${JSON.stringify(entry)};\n` +
        'console.log(create, url, fetchJSON, json);\n',
      resolveDir: root,
      loader: 'ts',
    },
    bundle: true,
    format: 'esm',
    minify: true,
    write: false,
    platform: 'browser',
    logLevel: 'silent',
  });

  const bundle = result.outputFiles[0].text;
  const bytes = Buffer.byteLength(bundle, 'utf8');
  const gzipped = gzipSync(Buffer.from(bundle, 'utf8'), { level: 9 }).length;

  console.log(`esbuild resolved from : ${esbuildPath}`);
  console.log(`entry                 : ${entry}`);
  console.log(`bundle size (min)     : ${bytes} B`);
  console.log(`bundle size (min+gz)  : ${gzipped} B`);

  const violations = FORBIDDEN_MARKERS.filter((marker) =>
    bundle.includes(marker),
  );

  if (violations.length > 0) {
    console.error('\ntree-shaking FAILED — middleware code survived in the bundle:');
    for (const marker of violations) {
      console.error(`  - "${marker}"`);
    }
    process.exit(1);
  }

  console.log(
    `\ntree-shaking OK — none of the ${FORBIDDEN_MARKERS.length} forbidden markers found ` +
      '(withProgress/withRetry/withAuth/withLogging and retry helpers are absent).',
  );
}

main().catch((error) => {
  console.error('tree-shaking verification failed to run:');
  console.error(error);
  process.exit(1);
});
