import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('..', import.meta.url));

// Deliberate allowlist, not the full default local suite. No App, browser,
// desktop tool, listener, real cloud/model or existing library is required.
export const CI_FILES = Object.freeze([
  'font-scale.test.mjs',
  'global-feedback.test.mjs',
  'read-cache.test.mjs',
  'search-aliases.test.mjs',
  'storyboard-model.test.mjs',
  'tag-facet-cache.test.mjs',
  'tag-usage.test.mjs',
]);
export const CI_TIMEOUT_MS = 120_000;

const trackedOutsideCi = Object.freeze([
  { file: 'concierge-attachments.test.mjs', issue: 7, reason: 'Local PDF/Office tool and baseline-failure investigation' },
  { file: 'timeline-render-picker.test.mjs', issue: 7, reason: 'Native App/picker baseline-failure investigation' },
  { file: 'audio-engine-installer.test.mjs', issue: 8, reason: 'Separate concurrent-installer qualification' },
]);

export async function ciSelection(directory = path.join(repo, 'tests')) {
  if (CI_FILES.length === 0) throw Error('CI allowlist must not be empty');
  const files = (await fs.readdir(directory, { withFileTypes: true }))
    .filter(entry => entry.isFile() && entry.name.endsWith('.test.mjs'))
    .map(entry => entry.name).sort();
  for (const file of CI_FILES) {
    if (!files.includes(file)) throw Error(`CI allowlist file is missing: tests/${file}`);
  }
  const cloud = files.filter(file => file.startsWith('cloud-') || file === 'device-enrollment.test.mjs');
  const tracked = trackedOutsideCi.filter(entry => files.includes(entry.file));
  const classified = new Set([...CI_FILES, ...cloud, ...tracked.map(entry => entry.file)]);
  return {
    suite: 'ci-stable-local-subset',
    runtime: process.version,
    included: [...CI_FILES],
    excluded: {
      cloud,
      trackedOutsideCi: tracked,
      otherLocal: files.filter(file => !classified.has(file)),
      browserUi: 'All *-ui.mjs; not selected by this entry point',
    },
    timeoutMsPerFile: CI_TIMEOUT_MS,
    concurrency: 1,
    fullNpmTest: false,
  };
}

export async function main(args = process.argv.slice(2)) {
  if (args.length > 1 || args.length === 1 && args[0] !== '--list') {
    throw Error('Usage: node scripts/ci-stable-tests.mjs [--list]');
  }
  const selection = await ciSelection();
  console.log(JSON.stringify(selection, null, 2));

  // #6 owns this runner and resource settlement. Do not duplicate it here or
  // silently fall back to an unbounded/full npm test when it is unavailable.
  let runner;
  try { runner = await import('./test-suites.mjs'); }
  catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
    throw Error('CI_RUNNER_UNAVAILABLE: integrate the independently accepted Issue #6 runner before enabling this workflow');
  }
  return runner.main([
    '--suite', 'local', '--timeout', String(CI_TIMEOUT_MS),
    ...CI_FILES.flatMap(file => ['--file', file]),
    ...(args[0] === '--list' ? ['--list'] : []),
  ]);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(code => { process.exitCode = code; }).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
