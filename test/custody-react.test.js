import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';
import { importView } from './helpers/react-view.js';
import { createCustodySession, depositMethods } from '../public/custody-session.js';

const { CustodyApp } = await importView('custody-view');
const profiles = {
  cosmos: { id: 'cosmos', transport: 'cosmos', chainId: 'synthetic-1', caip: 'cosmos:synthetic-1', profileDigest: 'digest-cosmos', denom: 'uclair' },
  evm: { id: 'evm', transport: 'evm', chainId: 'synthetic-2', evmChainId: '0x32f', caip: 'eip155:815', profileDigest: 'digest-evm', denom: 'aokrw' }
};

function runtimeFixture({ profile, onChange }) {
  const actor = { namespace: profile.transport === 'cosmos' ? 'cosmos' : 'eip155', chainId: profile.evmChainId || profile.chainId, address: 'synthetic-wallet' };
  const connection = { sessionHandle: 'session', accountHandle: 'account', networkHandle: 'network', permissions: ['deposit.request'],
    chainActors: [{ accountId: `${profile.caip}:${actor.address}`, chainActorHandle: 'actor' }] };
  const calls = [], listeners = new Set();
  let operation = { operationId: 'connect', kind: 'connect', state: 'completed', connection };
  let depositError = null;
  const provider = { onInvalidation(fn) { listeners.add(fn); return () => listeners.delete(fn); }, invalidate() { for (const fn of listeners) fn(); } };
  const client = {
    getCapabilities: async () => ({ methods: depositMethods, networks: [{ networkId: profile.id, chainId: profile.caip, profileDigest: profile.profileDigest }] }),
    connect: async () => { calls.push('connect'); return { operationId: 'connect', state: 'awaiting_approval' }; },
    getOperation: async () => { calls.push('poll'); return operation; },
    prepareDeposit: async params => { calls.push(['deposit', params.protocol.amountBaseUnits]); if (depositError) throw depositError; return { operationId: 'deposit', state: 'awaiting_approval' }; },
    submit: async () => { calls.push('submit'); return { invoked: true }; },
    reconcile: async () => { calls.push('reconcile'); },
    cancelOperation: async () => ({ operation: { ...operation, state: 'cancelled' } }),
    disconnect: async () => provider.invalidate()
  };
  const wallet = { connect: async () => actor, getActor: async () => actor };
  const session = createCustodySession({ profile, provider, client, wallet, onChange });
  const runtime = { session, calls, provider, disposed: 0,
    connectWallet: () => session.connectWallet(),
    setOperation: value => { operation = value; },
    failDeposit: () => { depositError = new Error('Synthetic timeout'); },
    dispose() { runtime.disposed++; session.dispose(); },
    lateNotify: () => onChange({ ...session.state, error: 'stale notification' })
  };
  return runtime;
}

async function mount(t, overrides = {}) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://127.0.0.1:4320/custody' });
  globalThis.window = dom.window; globalThis.document = dom.window.document;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(document.getElementById('root'));
  const runtimes = [];
  const createRuntime = args => { const runtime = runtimeFixture(args); runtimes.push(runtime); return runtime; };
  await act(async () => root.render(React.createElement(CustodyApp, { createRuntime, loadProfiles: async () => profiles, ...overrides })));
  t.after(async () => { await act(async () => root.unmount()); dom.window.close(); });
  const $ = id => document.getElementById(id);
  const click = id => act(async () => $(id).click());
  const update = callback => act(async () => callback());
  return { root, dom, runtimes, $, click, update };
}

async function connect(f) {
  await f.click('wallet'); await f.click('connect');
  await f.update(() => f.runtimes.at(-1).session.refresh());
}

test('React custody flow preserves explicit approval/signing and host-only confirmation', async t => {
  const f = await mount(t), runtime = f.runtimes[0];
  assert.equal(f.$('deposit').disabled, true);
  assert.equal(f.$('confirmed').hidden, true);
  await connect(f);
  assert.equal(f.$('network').disabled, true);
  assert.equal(f.$('deposit').disabled, false);
  await f.update(() => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(f.$('amount'), '19');
    f.$('amount').dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  await f.click('deposit');
  assert.deepEqual(runtime.calls.at(-1), ['deposit', '19']);
  assert.equal(f.$('cancel').disabled, false);
  assert.equal(f.$('submit').disabled, true);
  runtime.setOperation({ operationId: 'deposit', kind: 'deposit', state: 'awaiting_chain_signature', publicArtifact: {} });
  await f.update(() => runtime.session.refresh());
  assert.equal(f.$('submit').disabled, false);
  await f.click('submit'); await f.click('submit');
  assert.equal(runtime.calls.filter(value => value === 'submit').length, 1);
  assert.equal(f.$('confirmed').hidden, true);
  runtime.setOperation({ operationId: 'deposit', kind: 'deposit', state: 'submitted' });
  await f.update(() => runtime.session.refresh()); await f.click('reconcile');
  assert.equal(f.$('confirmed').hidden, true);
  runtime.setOperation({ operationId: 'deposit', kind: 'deposit', state: 'confirmed' });
  await f.update(() => runtime.session.refresh());
  assert.equal(f.$('confirmed').hidden, false);
  assert.equal(f.$('stepChain').className, 'done');
  assert.equal(f.$('deposit').disabled, false);
});

test('React custody controls fail closed on uncertainty and invalidation', async t => {
  const f = await mount(t), runtime = f.runtimes[0];
  await connect(f); runtime.failDeposit(); await f.click('deposit');
  assert.equal(f.$('error').hidden, false);
  assert.equal(f.$('deposit').disabled, true);
  await f.click('deposit');
  assert.equal(runtime.calls.filter(value => Array.isArray(value) && value[0] === 'deposit').length, 1);
  await f.update(() => runtime.provider.invalidate());
  assert.equal(f.$('submit').disabled, true);
  assert.equal(f.$('connect').disabled, true);
  assert.equal(f.$('custodyStatus').textContent, '연결 무효화됨');
});

test('React profile changes and pagehide dispose authority and ignore stale notifications', async t => {
  const f = await mount(t), previous = f.runtimes[0];
  await f.update(() => { f.$('network').value = 'evm'; f.$('network').dispatchEvent(new window.Event('change', { bubbles: true })); });
  assert.equal(previous.disposed, 1);
  assert.equal(f.runtimes.length, 2);
  assert.equal(f.$('wallet').textContent, 'MetaMask 연결');
  await f.update(() => previous.lateNotify());
  assert.equal(f.$('error').hidden, true);
  await f.update(() => window.dispatchEvent(new window.Event('pagehide')));
  assert.equal(f.runtimes[1].disposed, 1);
  assert.equal(f.$('wallet').disabled, true);
  await f.click('wallet');
  assert.equal(f.runtimes[1].session.state.actor, null);
});

test('React custody configuration failure keeps all authority actions disabled', async t => {
  const f = await mount(t, { loadProfiles: async () => { throw new Error('Synthetic config failure'); } });
  assert.equal(f.runtimes.length, 0);
  assert.equal(f.$('wallet').disabled, true);
  assert.equal(f.$('network').disabled, true);
  assert.equal(f.$('deposit').disabled, true);
  assert.equal(f.$('error').hidden, false);
});


test('React custody polls approval without signing and stops polling on pagehide', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const f = await mount(t), runtime = f.runtimes[0];
  await f.click('wallet'); await f.click('connect');
  assert.equal(f.$('deposit').disabled, true);
  await f.update(() => t.mock.timers.tick(1700));
  assert.equal(f.$('deposit').disabled, false);
  assert.equal(runtime.calls.filter(value => value === 'poll').length, 1);
  assert.equal(runtime.calls.includes('submit'), false);
  await f.update(() => window.dispatchEvent(new window.Event('pagehide')));
  await f.update(() => t.mock.timers.tick(3400));
  assert.equal(runtime.calls.filter(value => value === 'poll').length, 1);
});
