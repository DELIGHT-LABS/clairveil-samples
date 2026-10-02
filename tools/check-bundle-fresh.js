import { buildDapp } from './build-dapp.mjs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'clairveil-dapp-bundle-'));
try {
  await buildDapp({ outputDirectory: temporaryDirectory });
  const expected = await readFile(new URL('../public/app.bundle.js', import.meta.url));
  const generated = await readFile(path.join(temporaryDirectory, 'app.bundle.js'));
  if (!expected.equals(generated)) throw new Error('public/app.bundle.js is stale; run npm run build:dapp.');
} finally { await rm(temporaryDirectory, { recursive: true, force: true }); }
