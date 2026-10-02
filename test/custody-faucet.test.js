import test from 'node:test';
import assert from 'node:assert/strict';
import { faucetMatchesProfile, faucetAmount, requestSampleFaucet } from '../public/sample-faucet.js';

const profile = { transport: 'cosmos', chainId: 'synthetic-1', denom: 'uclair' };
const configuration = { ...profile, coinDecimals: 18, serverFeatures: { faucet: true } };
const actor = { address: 'clair1synthetic' };
function browserLocation(t) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'location');
  Object.defineProperty(globalThis, 'location', { value: { href: 'http://127.0.0.1:4320/' }, configurable: true });
  t.after(() => { if (original) Object.defineProperty(globalThis, 'location', original); else delete globalThis.location; });
}
function response(url, value, status = 200) {
  const result = new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
  Object.defineProperty(result, 'url', { value: url }); return result;
}

test('faucet decimal inputs retain exact base units and reject excess precision', () => {
  assert.equal(faucetAmount('0.000000000000001', 18, 'uclair'), '1000uclair');
  assert.equal(faucetAmount('9.007199254740993001', 18, 'uclair'), '9007199254740993001uclair');
  for (const value of ['0', '-1', '1e3', '01', '1.0000000000000000001']) assert.throws(() => faucetAmount(value, 18, 'uclair'));
  assert.equal(faucetMatchesProfile(configuration, profile), true);
  for (const other of [{ ...configuration, chainId: 'other' }, { ...configuration, denom: 'other' }, { ...configuration, coinDecimals: 19 }, { ...configuration, serverFeatures: {} }]) {
    assert.equal(faucetMatchesProfile(other, profile), false);
  }
  const evm = { transport: 'evm', chainId: 'synthetic-2', evmChainId: '0x32f', denom: 'aokrw' };
  assert.equal(faucetMatchesProfile({ ...configuration, ...evm, evmChainId: '815' }, evm), true);
  assert.equal(faucetMatchesProfile({ ...configuration, ...evm, evmChainId: {} }, evm), false);
});

test('faucet sends one bounded same-origin request to the connected ordinary account', async t => {
  browserLocation(t); const calls = []; let attempted = false;
  const hash = 'a'.repeat(64);
  const result = await requestSampleFaucet({ configuration, profile, actor, amount: '0.000000000000001', beforeDispatch: () => { attempted = true; },
    fetchImpl: async (url, options) => {
      assert.equal(attempted, true); calls.push({ url, options });
      return response(url, { broadcast: { txhash: hash }, tx: { txhash: hash, code: 0, height: '8' },
        included: true, unknown: false, failed: false, recipient: actor.address, amount: { funded: '1000uclair' } });
    } });
  assert.deepEqual(result, { hash, amount: '1000uclair', confirmed: true });
  assert.equal(calls.length, 1); assert.equal(calls[0].url, 'http://127.0.0.1:4320/api/faucet');
  assert.deepEqual(JSON.parse(calls[0].options.body), { recipient: actor.address, amount: '1000uclair' });
  assert.equal(calls[0].options.method, 'POST'); assert.equal(calls[0].options.credentials, 'omit');
  assert.equal(calls[0].options.redirect, 'error');
});

test('faucet input errors stop before dispatch; lost or mismatched responses never retry', async t => {
  browserLocation(t); let attempts = 0, requests = 0;
  const args = { configuration, profile, actor, amount: '1', beforeDispatch: () => { attempts++; }, fetchImpl: async () => { requests++; throw new Error('lost reply'); } };
  await assert.rejects(requestSampleFaucet({ ...args, amount: '1e3' }));
  await assert.rejects(requestSampleFaucet({ ...args, configuration: { ...configuration, chainId: 'wrong' } }));
  assert.equal(attempts, 0); assert.equal(requests, 0);
  await assert.rejects(requestSampleFaucet(args), /lost reply/);
  assert.equal(attempts, 1); assert.equal(requests, 1);
  await assert.rejects(requestSampleFaucet({ ...args, fetchImpl: async url => response(url, {
    recipient: 'other-recipient', amount: { funded: '1000000000000000000uclair' }, broadcast: { txhash: 'a'.repeat(64) }
  }) }), /does not match/);
});

test('a faucet inclusion flag with missing or failed chain evidence remains unconfirmed', async t => {
  browserLocation(t);
  for (const tx of [undefined, { txhash: 'a'.repeat(64), height: '8', code: null }, { txhash: 'a'.repeat(64), height: '8', code: 1 }, { txhash: 'b'.repeat(64), height: '8', code: 0 }]) {
    const result = await requestSampleFaucet({ configuration, profile, actor, amount: '1', beforeDispatch() {},
      fetchImpl: async url => response(url, { recipient: actor.address, amount: { funded: '1000000000000000000uclair' },
        broadcast: { txhash: 'a'.repeat(64) }, included: true, unknown: false, failed: false, tx }) });
    assert.equal(result.confirmed, false);
  }
});

test('faucet funds and fee rejection exposes a validated hash and permits explicit retry', async t => {
  browserLocation(t);
  for (const txCode of [5, 13]) {
    let requests = 0;
    await assert.rejects(requestSampleFaucet({ configuration, profile, actor, amount: '1', beforeDispatch() {},
      fetchImpl: async url => {
        requests++;
        return response(url, { checkTxRejected: true, rpcInvoked: true, txCode, txCodespace: 'sdk', txHeight: '0', txHash: 'A'.repeat(64) }, 400);
      } }), error => error.faucetRejected === true && error.hash === 'a'.repeat(64) && error.amount === '1000000000000000000uclair');
    assert.equal(requests, 1, 'never retries automatically');
  }
});

test('ambiguous faucet CheckTx errors retain their hash without permitting another request', async t => {
  browserLocation(t);
  for (const change of [{ txCode: 19 }, { txCode: 32 }, { txCode: 99 }, { txCodespace: 'other' }, { txCodespace: undefined }, { txHeight: '8' }, { txHeight: undefined }]) {
    await assert.rejects(requestSampleFaucet({ configuration, profile, actor, amount: '1', beforeDispatch() {},
      fetchImpl: async url => response(url, { checkTxRejected: true, rpcInvoked: true, txCode: 5, txCodespace: 'sdk', txHeight: '0', txHash: 'A'.repeat(64), ...change }, 400)
    }), error => error.faucetRejected === false && error.hash === 'a'.repeat(64));
  }
});

test('untrusted or incomplete faucet error bodies never release the pending request', async t => {
  browserLocation(t);
  const evidence = { checkTxRejected: true, rpcInvoked: true, txCode: 5, txCodespace: 'sdk', txHeight: '0', txHash: 'a'.repeat(64) };
  for (const change of [{ checkTxRejected: 'true' }, { rpcInvoked: false }, { txCode: '5' }, { txCode: 0 }, { txHash: 'bad' }]) {
    await assert.rejects(requestSampleFaucet({ configuration, profile, actor, amount: '1', beforeDispatch() {},
      fetchImpl: async url => response(url, { ...evidence, ...change }, 400)
    }), error => error.faucetRejected !== true && error.hash === undefined);
  }
  for (const status of [403, 500, 503]) {
    await assert.rejects(requestSampleFaucet({ configuration, profile, actor, amount: '1', beforeDispatch() {},
      fetchImpl: async url => response(url, evidence, status)
    }), error => error.faucetRejected !== true && error.hash === undefined);
  }
});
