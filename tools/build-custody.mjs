import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const custody = path.resolve(root, process.env.CLAIRVEIL_CUSTODY_DIR || '../clairveil-custody');
const result = spawnSync('npm', ['run', 'custody:local-build'], { cwd: custody, stdio: 'inherit' });
if (result.error || result.status !== 0) throw new Error('Build CC-004 with the pinned SDK and running local services; see README.md.', { cause: result.error });
const source = path.join(custody, '.spike-build/cc004-host');
const evidence = JSON.parse(await readFile(path.join(source, 'build-evidence.json')));
// Both upstream builders verify the archive and installed consumer. Bind these
// public profiles to every emitted extension/fixture byte before consuming them.
for (const [name, expected] of Object.entries(evidence.files)) {
  if (createHash('sha256').update(await readFile(path.join(source, name))).digest('hex') !== expected) throw new Error('CUSTODY_BUILD_CHANGED');
}
const { deployments, networks } = JSON.parse(await readFile(path.join(source, 'profiles.json')));
const profiles = JSON.stringify(Object.fromEntries(deployments.map(({ preparation: p }) => {
  const network = networks.find(value => value.networkId === p.reader.networkId);
  if (!network) throw new Error('CUSTODY_NETWORK_MISSING');
  return [p.transport, { id: p.reader.networkId, transport: p.transport, chainId: p.reader.chainId,
    caip: network.chainId, profileDigest: network.profileDigest, denom: p.denom, prefix: p.accountPrefix,
    rpc: p.reader.rpc, rest: p.reader.rest, evmRpc: p.evmRpc, evmChainId: p.evmChainId, contract: p.contract }];
})), null, 2);
const pin = JSON.parse(await readFile(path.join(custody, 'tests/custody/sdk-package.json')));
if (pin.integrity !== evidence.sdk.integrity) throw new Error('CUSTODY_SDK_MISMATCH');
const consumer = path.resolve(custody, process.env.CC003_CONSUMER_DIR || pin.consumer);
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
  host: 'CC-004', sdk: evidence.sdk, sdkSource: evidence.sdkSource, sourceBuild: evidence.files, files, inputs
}, null, 2));
console.log('CC-004 custody page built with the pinned SDK; no legacy privacy modules in its bundle.');
