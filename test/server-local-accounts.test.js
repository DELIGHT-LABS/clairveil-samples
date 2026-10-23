import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';

const source = await readFile(new URL('../server.js', import.meta.url), 'utf8');
const start = source.indexOf('async function localAccounts(');
const end = source.indexOf('\nfunction validateAccount(', start);
assert.ok(start > 0 && end > start);
async function accounts({ localTestMode = true, metadata = {}, transport = 'cosmos' } = {}) {
  const calls = [];
  const context = vm.createContext({ config: { localTestMode, home: '/synthetic-chain' },
    isEvmTransport: () => transport === 'evm', join: path.join,
    cosmosAccountNames: new Set(['alice', 'bob']),
    readTextIfExists: async name => metadata[name] || '',
    localSignerNames: () => new Set(['alice', 'bob']),
    localSignerKeyring: () => 'test', localSignerHome: () => '/synthetic-signer',
    runLocalSigner: async (args, options) => {
      calls.push({ args, options });
      return { json: [
        { name: 'alice', address: 'synthetic-alice', extra: 'not-for-the-page' },
        { name: 'bob', address: 'synthetic-bob' }, { name: 'unrelated', address: 'excluded' }
      ] };
    }
  });
  const result = await vm.runInContext(`${source.slice(start, end)}\nlocalAccounts()`, context);
  return { result: JSON.parse(JSON.stringify(result)), calls };
}

test('Cosmos test accounts remain discoverable without generated init-out files', async () => {
  const { result, calls } = await accounts();
  assert.deepEqual(result, [
    { name: 'alice', transparentAddress: 'synthetic-alice' },
    { name: 'bob', transparentAddress: 'synthetic-bob' }
  ]);
  assert.equal(calls.length, 1);
  assert.deepEqual(Array.from(calls[0].args), ['keys', 'list', '--keyring-backend', 'test', '--home', '/synthetic-signer', '--output', 'json']);
});

test('existing Cosmos metadata and EVM keyring lookup remain supported', async () => {
  const existing = await accounts({ metadata: { '/synthetic-chain/init-out/alice-address.txt': 'existing-alice' } });
  assert.deepEqual(existing.result, [{ name: 'alice', transparentAddress: 'existing-alice' }]);
  assert.equal(existing.calls.length, 0);
  assert.equal((await accounts({ transport: 'evm' })).result.length, 2);
});

test('public mode does not inspect a local keyring', async () => {
  const { result, calls } = await accounts({ localTestMode: false });
  assert.deepEqual(result, []); assert.equal(calls.length, 0);
});
