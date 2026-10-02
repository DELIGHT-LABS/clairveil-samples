import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

test('CI builds the pinned public SDK without a custody checkout; local execution still requires its host', async t => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'sample-custody-build-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = fileURLToPath(new URL('../', import.meta.url));
  const script = `import { buildDapp } from './tools/build-dapp.mjs'; await buildDapp({ outputDirectory: process.argv[1], localHost: process.argv[2] === 'local' });`;
  const run = (output, mode) => promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, output, mode], {
    cwd: root, env: { ...process.env, CLAIRVEIL_CUSTODY_DIR: path.join(temporary, 'absent-custody') }
  });
  const output = path.join(temporary, 'web');
  await run(output, 'ci');
  assert((await stat(path.join(output, 'app.bundle.js'))).size > 0);
  assert.deepEqual(await readFile(path.join(output, 'app.bundle.js')), await readFile(path.join(root, 'public/app.bundle.js')));
  await assert.rejects(stat(path.join(output, 'custody-profiles.json')), { code: 'ENOENT' });
  await assert.rejects(run(path.join(temporary, 'local-web'), 'local'), /build-evidence.json/);
});
