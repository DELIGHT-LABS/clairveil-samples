import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { custodySdkAliases, verifySampleCustodySdk } from './custody-sdk.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const custody = path.resolve(root, process.env.CLAIRVEIL_CUSTODY_DIR || '../clairveil-custody');
async function verifyLocalHost(samplePin) {
  const source = path.join(custody, '.spike-build/cc007-host');
  const evidence = JSON.parse(await readFile(path.join(source, 'build-evidence.json')));
  if (evidence.candidate !== 'cc007') throw new Error('CC007_HOST_REQUIRED');
  // Both upstream builders verify the archive and installed consumer. Bind these
  // public profiles to every emitted extension/fixture byte before consuming them.
  for (const [name, expected] of Object.entries(evidence.files)) {
    if (createHash('sha256').update(await readFile(path.join(source, name))).digest('hex') !== expected) throw new Error('CUSTODY_BUILD_CHANGED');
  }
  const { deployments, networks, registrations } = JSON.parse(await readFile(path.join(source, 'profiles.json')));
  if (!Array.isArray(registrations) || registrations.length !== deployments.length) {
    throw new Error('CUSTODY_NETWORK_REGISTRATION_BUILD_REQUIRED: rebuild the local custody host before building this sample');
  }
  const profiles = JSON.stringify(Object.fromEntries(deployments.map(({ preparation: p }) => {
    const network = networks.find(value => value.networkId === p.reader.networkId);
    const registration = registrations.find(value => value.deployment.preparation.reader.networkId === p.reader.networkId);
    if (!network || !registration) throw new Error('CUSTODY_NETWORK_MISSING');
    return [p.transport, { id: p.reader.networkId, transport: p.transport, chainId: p.reader.chainId,
      registration,
      caip: network.chainId, profileDigest: network.profileDigest, denom: p.denom, prefix: p.accountPrefix,
      rpc: p.reader.rpc, rest: p.reader.rest, evmRpc: p.evmRpc, evmChainId: p.evmChainId, contract: p.contract }];
  })), null, 2);
  const pin = JSON.parse(await readFile(path.join(custody, 'tests/custody/sdk-package.json')));
  if (pin.integrity !== samplePin.integrity || JSON.stringify(pin.source) !== JSON.stringify(samplePin.source)) throw new Error('SAMPLE_CUSTODY_SDK_MISMATCH');
  if (pin.integrity !== evidence.sdk.integrity) throw new Error('CUSTODY_SDK_MISMATCH');
  const archive = path.resolve(custody, process.env.CC003_SDK_TARBALL || pin.tarball);
  if (`sha512-${createHash('sha512').update(await readFile(archive)).digest('base64')}` !== pin.integrity) throw new Error('CUSTODY_SDK_ARCHIVE_CHANGED');
  const consumer = path.resolve(custody, process.env.CC003_CONSUMER_DIR || pin.consumer);
  const verifierPath = path.join(custody, 'scripts/integration-artifact.mjs');
  const { verifyIntegrationSdk } = await import(pathToFileURL(verifierPath));
  const verifiedSdk = await verifyIntegrationSdk({ tarball: archive, integrity: pin.integrity, consumer });
  if (verifiedSdk.consumerLockSha256 !== evidence.consumerLockSha256) throw new Error('CUSTODY_CONSUMER_LOCK_CHANGED');
  const hostVerifierPath = path.join(custody, 'scripts/custody-local-artifact.mjs');
  const { verifyCustodyLocalBuild } = await import(pathToFileURL(hostVerifierPath));
  await verifyCustodyLocalBuild(source, verifiedSdk);
  if (JSON.stringify(evidence.sdkSource) !== JSON.stringify(pin.source)
    || createHash('sha256').update(await readFile(path.resolve(custody, pin.patch))).digest('hex') !== pin.source.patchSha256) throw new Error('CUSTODY_SDK_SOURCE_CHANGED');
  return { profiles, evidence, source, verifierPath, hostVerifierPath };
}

export async function buildDapp({ outputDirectory = path.join(root, 'public'), localHost = false } = {}) {
  const pin = await verifySampleCustodySdk();
  const host = localHost ? await verifyLocalHost(pin) : null;
  const output = outputDirectory;
  await mkdir(output, { recursive: true });
  const alias = await custodySdkAliases();
  const bundle = await build({ absWorkingDir: root, entryPoints: ['public/dapp-entry.jsx'], bundle: true, minify: true,
    format: 'esm', platform: 'browser', target: 'es2022', outfile: path.join(output, 'app.bundle.js'), metafile: true,
    alias, define: { 'process.env.NODE_ENV': '"production"' } });
  const inputs = Object.keys(bundle.metafile.inputs);
  if (inputs.some(name => /\/src\/(?:core|privacy|wallet-kernel|transport|browser|wallet)\//.test(name) || /(?:encrypted-.*store|app\.js$)/.test(name) && !name.endsWith('custody-runtime.js') && !name.endsWith('sample-custody-app.js'))) throw new Error('PRIVATE_MODULE_IN_CUSTODY_PAGE');
  if (host) await writeFile(path.join(output, 'custody-profiles.json'), host.profiles);
  for (const name of ['index.html', 'styles.css']) await copyFile(path.join(root, 'public', name), path.join(output, name));
  const inputHashes = {};
  for (const file of host ? [host.verifierPath, host.hostVerifierPath] : []) inputHashes[path.relative(root, file)] = createHash('sha256').update(await readFile(file)).digest('hex');
  for (const name of [...inputs, 'tools/build-dapp.mjs', 'tools/custody-sdk.mjs', 'vendor/custody-sdk.json', pin.archive, 'server-custody-proxy.js', 'server.js', 'public/index.html', 'public/styles.css', 'package.json', 'package-lock.json']) {
    inputHashes[name] = createHash('sha256').update(await readFile(path.resolve(root, name))).digest('hex');
  }
  const files = {};
  for (const name of ['index.html', 'styles.css', 'app.bundle.js', ...(host ? ['custody-profiles.json'] : [])]) {
    files[name] = createHash('sha256').update(await readFile(path.join(output, name))).digest('hex');
  }
  if (host) await writeFile(path.join(output, 'custody-build.json'), JSON.stringify({
    host: 'CC-007', hostBuildSha256: createHash('sha256').update(await readFile(path.join(host.source, 'build-evidence.json'))).digest('hex'), node: process.version, inputHashes, sdk: host.evidence.sdk, sdkSource: pin.source, sourceBuild: host.evidence.files, files, inputs
  }, null, 2));
  return { inputs, files };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildDapp({ localHost: process.argv.includes('--local-host') });
  console.log('Default sample app built with the pinned custody SDK; no page privacy kernel or legacy controller.');
}
