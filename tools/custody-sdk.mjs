import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const root = fileURLToPath(new URL('../', import.meta.url));
export const custodySdkRoot = path.join(root, 'node_modules/@clairveil/custody-sdk');
const run = promisify(execFile);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

export async function custodySdkAliases() {
  const pkg = JSON.parse(await readFile(path.join(custodySdkRoot, 'package.json')));
  const require = createRequire(path.join(custodySdkRoot, 'package.json'));
  return {
    ...Object.fromEntries(['custody-provider', 'dapp', 'chain-wallet'].map(name => [`clairveiljs/${name}`, path.join(custodySdkRoot, pkg.exports[`./${name}`].import)])),
    'cosmjs-types': path.dirname(require.resolve('cosmjs-types/binary')),
    '@cosmjs/encoding': require.resolve('@cosmjs/encoding')
  };
}

// The committed archive is the exact unreleased SDK snapshot used by custody.
// Check installed bytes as well as npm metadata, without requiring a live host.
export async function verifySampleCustodySdk() {
  const pin = JSON.parse(await readFile(path.join(root, 'vendor/custody-sdk.json')));
  const archive = path.join(root, pin.archive);
  assert.equal(`sha512-${createHash('sha512').update(await readFile(archive)).digest('base64')}`, pin.integrity, 'CUSTODY_SDK_ARCHIVE_CHANGED');
  const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json')));
  assert.equal(lock.packages['node_modules/@clairveil/custody-sdk'].integrity, pin.integrity, 'CUSTODY_SDK_LOCK_CHANGED');
  const { stdout } = await run('tar', ['-tzf', archive]);
  const entries = stdout.trim().split('\n').filter(name => !name.endsWith('/'));
  assert(entries.length && entries.every(name => name.startsWith('package/') && !name.split('/').includes('..')), 'CUSTODY_SDK_ARCHIVE_PATH');
  const names = entries.map(name => name.slice(8)).sort();
  assert.equal(new Set(names).size, names.length, 'CUSTODY_SDK_DUPLICATE_PATH');
  async function inventory(directory = '') {
    const files = [];
    for (const item of await readdir(path.join(custodySdkRoot, directory), { withFileTypes: true })) {
      const name = path.posix.join(directory, item.name);
      if (item.isDirectory()) files.push(...await inventory(name));
      else if (item.isFile()) files.push(name);
      else throw new Error('CUSTODY_SDK_SPECIAL_FILE');
    }
    return files.sort();
  }
  assert.deepEqual(await inventory(), names, 'CUSTODY_SDK_INSTALLED_FILES_CHANGED');
  for (let offset = 0; offset < entries.length; offset += 8) {
    await Promise.all(entries.slice(offset, offset + 8).map(async name => {
      const { stdout: bytes } = await run('tar', ['-xOzf', archive, name], { encoding: 'buffer', maxBuffer: 16777216 });
      assert.equal(hash(await readFile(path.join(custodySdkRoot, name.slice(8)))), hash(bytes), `CUSTODY_SDK_INSTALLED_BYTES_CHANGED: ${name}`);
    }));
  }
  return pin;
}
