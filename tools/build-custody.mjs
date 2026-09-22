import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const custody = path.resolve(root, process.env.CLAIRVEIL_CUSTODY_DIR || '../clairveil-custody');
const result = spawnSync(process.execPath, [path.join(custody, 'scripts/build-manual-preview.mjs')], { cwd: custody, stdio: 'inherit' });
if (result.error || result.status !== 0) throw new Error('Build the pinned CC-002 integration artifacts first; see README.md (Custody preview).', { cause: result.error });
const source = path.join(custody, '.spike-build/cc002-manual');
const evidence = JSON.parse(await readFile(path.join(source, 'preview-evidence.json')));
const profiles = await readFile(path.join(source, 'extension/profiles.json'));
if (createHash('sha256').update(profiles).digest('hex') !== evidence.files['profiles.json']) throw new Error('CUSTODY_PROFILES_CHANGED');
const consumer = path.resolve(custody, process.env.CC002_CONSUMER_DIR || '.spike-build/cc002-consumer/node_modules');
const sdkRoot = path.join(consumer, 'clairveiljs');
const sdkPackage = JSON.parse(await readFile(path.join(sdkRoot, 'package.json')));
const alias = Object.fromEntries(['custody-provider', 'dapp', 'chain-wallet'].map(name => [`clairveiljs/${name}`, path.join(sdkRoot, sdkPackage.exports[`./${name}`].import)]));
const bundle = await build({ absWorkingDir: root, entryPoints: ['public/custody-entry.jsx'], bundle: true, minify: true,
  format: 'esm', platform: 'browser', target: 'es2022', outfile: 'public/custody.bundle.js', metafile: true,
  alias });
const inputs = Object.keys(bundle.metafile.inputs);
if (inputs.some(name => /\/src\/(?:core|privacy|wallet-kernel|transport|browser|wallet)\//.test(name) || /(?:encrypted-.*store|app\.js$)/.test(name) && !name.endsWith('custody-app.js'))) throw new Error('PRIVATE_MODULE_IN_CUSTODY_PAGE');
await writeFile(path.join(root, 'public/custody-profiles.json'), profiles);
const files = {};
for (const name of ['custody.html', 'custody.css', 'custody.bundle.js', 'custody-profiles.json']) {
  files[name] = createHash('sha256').update(await readFile(path.join(root, 'public', name))).digest('hex');
}
await writeFile(path.join(root, 'public/custody-build.json'), JSON.stringify({
  sdk: evidence.sourceEvidence.sdk, sourceBuild: evidence.sourceEvidence.files, files, inputs
}, null, 2));
console.log('Custody page built with the pinned SDK; no legacy privacy modules in its bundle.');
